use std::future::Future;
use std::time::{Duration, Instant};

use gjd_core::VARIANT_SET_PROVIDER_SCHEMA;
use gjd_core::contracts::VariantSet;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::schema::{STRICT_SCHEMA, drop_null_optionals};
use crate::{GenerationOutput, GenerationRequest, ProviderError, ProviderEvent, RunTimings};

const MIN_RETRY_WINDOW: Duration = Duration::from_secs(10);
const NO_JSON: &str = "the answer contains no JSON object";

pub(crate) struct TextRun {
    pub(crate) text: String,
    pub(crate) timings: RunTimings,
    pub(crate) cost_usd: Option<f64>,
}

pub(crate) fn schema_instructions() -> String {
    format!(
        "Reply with exactly one JSON object and nothing else: no prose before or after it and no \
         Markdown fences. It must match this JSON Schema:\n{VARIANT_SET_PROVIDER_SCHEMA}"
    )
}

enum Rejected {
    NotJson(String),
    Invalid(String),
}

fn parse(candidate: &str) -> Result<VariantSet, Rejected> {
    let mut value: Value = serde_json::from_str(candidate)
        .map_err(|error| Rejected::NotJson(format!("it is not valid JSON ({error})")))?;
    if !value.is_object() {
        return Err(Rejected::NotJson("it is not a JSON object".to_owned()));
    }
    drop_null_optionals(&mut value, &STRICT_SCHEMA.nullable);
    serde_json::from_value(value).map_err(|error| {
        Rejected::Invalid(format!("it does not match the required shape ({error})"))
    })
}

fn fenced_blocks(text: &str) -> Vec<&str> {
    let mut blocks = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find("```") {
        let after = &rest[open + 3..];
        let Some(newline) = after.find('\n') else {
            break;
        };
        let body = &after[newline + 1..];
        let Some(close) = body.find("```") else {
            break;
        };
        blocks.push(body[..close].trim());
        rest = &body[close + 3..];
    }
    blocks
}

fn balanced_objects(text: &str) -> Vec<&str> {
    let mut objects = Vec::new();
    let mut depth = 0usize;
    let mut start = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (index, ch) in text.char_indices() {
        if in_string {
            match ch {
                _ if escaped => escaped = false,
                '\\' => escaped = true,
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match ch {
            '"' if depth > 0 => in_string = true,
            '{' => {
                if depth == 0 {
                    start = index;
                }
                depth += 1;
            }
            '}' if depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    objects.push(&text[start..=index]);
                }
            }
            _ => {}
        }
    }
    objects
}

pub(crate) fn extract_variant_set(text: &str) -> Result<VariantSet, String> {
    let trimmed = text.trim();
    let mut candidates = vec![trimmed];
    candidates.extend(fenced_blocks(trimmed));
    candidates.extend(balanced_objects(trimmed));
    let mut not_json = None;
    let mut invalid = None;
    let mut seen = Vec::new();
    for candidate in candidates {
        if candidate.is_empty() || seen.contains(&candidate) {
            continue;
        }
        seen.push(candidate);
        match parse(candidate) {
            Ok(set) => return Ok(set),
            Err(Rejected::Invalid(reason)) => {
                invalid.get_or_insert(reason);
            }
            Err(Rejected::NotJson(reason)) => {
                not_json.get_or_insert(reason);
            }
        }
    }
    Err(invalid
        .or_else(|| (balanced_objects(trimmed).is_empty()).then(|| NO_JSON.to_owned()))
        .or(not_json)
        .unwrap_or_else(|| NO_JSON.to_owned()))
}

fn with_instructions(mut request: GenerationRequest) -> GenerationRequest {
    request.system_prompt = format!("{}\n\n{}", request.system_prompt, schema_instructions());
    request
}

pub(crate) async fn generate_with_retry<F, Fut>(
    request: GenerationRequest,
    cancel: &CancellationToken,
    mut attempt: F,
) -> Result<GenerationOutput, ProviderError>
where
    F: FnMut(GenerationRequest) -> Fut,
    Fut: Future<Output = Result<TextRun, ProviderError>>,
{
    let started = Instant::now();
    let budget = request.timeout;
    let request = with_instructions(request);
    let first = attempt(request.clone()).await?;
    let reason = match extract_variant_set(&first.text) {
        Ok(variant_set) => {
            return Ok(GenerationOutput {
                variant_set,
                timings: first.timings,
                cost_usd: first.cost_usd,
            });
        }
        Err(reason) => reason,
    };
    if cancel.is_cancelled() {
        return Err(ProviderError::Cancelled);
    }
    let remaining = budget.saturating_sub(started.elapsed());
    if remaining < MIN_RETRY_WINDOW {
        return Err(ProviderError::InvalidOutput(reason));
    }
    request.emit(ProviderEvent::Retrying(reason.clone()));
    let mut retry = request;
    retry.timeout = remaining;
    retry.user_prompt = format!(
        "{}\n\nYour previous answer could not be used: {reason}. Reply again with only the JSON \
         object.",
        retry.user_prompt
    );
    let second = attempt(retry).await?;
    let variant_set = extract_variant_set(&second.text).map_err(ProviderError::InvalidOutput)?;
    Ok(GenerationOutput {
        variant_set,
        timings: RunTimings {
            ready: first.timings.ready,
            answer: started.elapsed(),
        },
        cost_usd: match (first.cost_usd, second.cost_usd) {
            (Some(a), Some(b)) => Some(a + b),
            (a, b) => a.or(b),
        },
    })
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::path::PathBuf;
    use std::time::Duration;

    use tokio_util::sync::CancellationToken;

    use super::{TextRun, extract_variant_set, generate_with_retry};
    use crate::{GenerationRequest, ProviderError, ProviderEvent, RunTimings, ToolPolicy};

    const ANSWER: &str = r#"{"answer":"It sits in the header.","variants":[]}"#;

    #[test]
    fn finds_the_answer_in_plain_fenced_or_wrapped_text() {
        let cases = [
            ANSWER.to_owned(),
            format!("```json\n{ANSWER}\n```"),
            format!("Sure! Here it is:\n```\n{ANSWER}\n```\nHope that helps."),
            format!("Here you go: {ANSWER} Let me know."),
            format!("{{\"note\": \"draft\"}}\n{ANSWER}"),
            r#"{"answer":"Use { and } freely, even \"quoted\" ones.","variants":[]}"#.to_owned(),
            r#"{"answer":null,"variants":[]}"#.to_owned(),
        ];
        for text in cases {
            let set = extract_variant_set(&text).unwrap_or_else(|error| panic!("{error}: {text}"));
            assert!(set.variants.is_empty(), "{text}");
        }
    }

    #[test]
    fn explains_why_nothing_could_be_used() {
        assert_eq!(
            extract_variant_set("I could not do that.").expect_err("no json"),
            "the answer contains no JSON object"
        );
        let invalid = extract_variant_set(r#"{"variants":[{"label":"x"}]}"#).expect_err("invalid");
        assert!(
            invalid.starts_with("it does not match the required shape"),
            "{invalid}"
        );
        let broken = extract_variant_set(r#"{"variants": [}"#).expect_err("broken");
        assert!(broken.starts_with("it is not valid JSON"), "{broken}");
    }

    fn request() -> GenerationRequest {
        GenerationRequest {
            model: None,
            effort: None,
            system_prompt: "Be brief.".to_owned(),
            user_prompt: "Where is the logo?".to_owned(),
            images: Vec::new(),
            tools: ToolPolicy::None,
            timeout: Duration::from_secs(60),
            cwd: PathBuf::from("."),
            events: None,
        }
    }

    fn reply(text: &str) -> TextRun {
        TextRun {
            text: text.to_owned(),
            timings: RunTimings {
                ready: Some(Duration::from_millis(5)),
                answer: Duration::from_millis(10),
            },
            cost_usd: Some(0.01),
        }
    }

    #[tokio::test]
    async fn retries_once_with_the_reason_and_the_schema() {
        let prompts = RefCell::new(Vec::new());
        let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
        let watched = GenerationRequest {
            events: Some(events),
            ..request()
        };
        let output = generate_with_retry(watched, &CancellationToken::new(), |sent| {
            prompts
                .borrow_mut()
                .push((sent.system_prompt, sent.user_prompt));
            let first = prompts.borrow().len() == 1;
            async move {
                Ok(reply(if first {
                    "Sorry, here is prose."
                } else {
                    ANSWER
                }))
            }
        })
        .await
        .expect("the retry answers");

        let prompts = prompts.into_inner();
        assert_eq!(prompts.len(), 2);
        assert!(
            prompts[0]
                .0
                .starts_with("Be brief.\n\nReply with exactly one JSON object")
        );
        assert!(prompts[0].0.contains("\"variants\""));
        assert!(
            prompts[1]
                .1
                .contains("could not be used: the answer contains no JSON object")
        );
        assert!(output.variant_set.variants.is_empty());
        assert!((output.cost_usd.expect("cost") - 0.02).abs() < 1e-9);
        assert_eq!(
            received.try_recv().ok(),
            Some(ProviderEvent::Retrying(
                "the answer contains no JSON object".to_owned()
            ))
        );
    }

    #[tokio::test]
    async fn gives_up_after_the_second_unusable_answer_and_skips_retry_when_cancelled() {
        let calls = RefCell::new(0);
        let failure = generate_with_retry(request(), &CancellationToken::new(), |_| {
            *calls.borrow_mut() += 1;
            async { Ok(reply("still prose")) }
        })
        .await
        .expect_err("no usable answer");
        assert!(matches!(failure, ProviderError::InvalidOutput(_)));
        assert_eq!(*calls.borrow(), 2);

        let cancel = CancellationToken::new();
        cancel.cancel();
        let cancelled = generate_with_retry(request(), &cancel, |_| async { Ok(reply("prose")) })
            .await
            .expect_err("cancelled");
        assert!(matches!(cancelled, ProviderError::Cancelled));
    }
}
