use std::collections::BTreeSet;

use super::scope::Scope;

const CLASS_WEIGHT: f64 = 0.45;
const NAME_WEIGHT: f64 = 0.25;
const TAG_WEIGHT: f64 = 0.1;
const POPULAR_WEIGHT: f64 = 0.1;
const NAMED_BONUS: f64 = 0.5;
const MIN_SCORE: f64 = 0.3;
const MIN_CLASS: f64 = 0.2;
const MIN_NAME: f64 = 0.5;
const POPULAR_SCALE: f64 = 11.0;
const MAX_JOINED: usize = 3;
const MIN_WORD: usize = 3;

const NOISE: [&str; 40] = [
    "the",
    "and",
    "this",
    "that",
    "with",
    "from",
    "here",
    "there",
    "into",
    "make",
    "use",
    "please",
    "for",
    "its",
    "same",
    "like",
    "think",
    "want",
    "you",
    "your",
    "our",
    "already",
    "existing",
    "exist",
    "exists",
    "component",
    "components",
    "reuse",
    "reusable",
    "search",
    "find",
    "look",
    "codebase",
    "across",
    "project",
    "whole",
    "app",
    "one",
    "instead",
    "should",
];

const SEMANTIC: [(&[&str], &[&str]); 9] = [
    (
        &[
            "red",
            "rose",
            "destructive",
            "danger",
            "error",
            "errors",
            "invalid",
            "required",
            "failed",
            "fail",
            "wrong",
        ],
        &[
            "error",
            "errors",
            "alert",
            "danger",
            "invalid",
            "validation",
        ],
    ),
    (
        &["green", "emerald", "success", "saved", "done", "complete"],
        &["success", "check", "confirm"],
    ),
    (
        &["amber", "yellow", "orange", "warning", "warn", "caution"],
        &["warning", "warn", "caution", "alert"],
    ),
    (
        &["info", "note", "hint", "tip", "help"],
        &["info", "note", "hint", "tip", "help", "callout"],
    ),
    (
        &["button", "btn", "cta"],
        &["button", "btn", "action", "cta"],
    ),
    (
        &["input", "textarea", "select", "field"],
        &["input", "field", "select"],
    ),
    (
        &["h1", "h2", "h3", "h4", "h5", "h6", "heading", "title"],
        &["heading", "title"],
    ),
    (
        &["badge", "pill", "chip", "tag"],
        &["badge", "pill", "chip", "tag"],
    ),
    (&["card", "article"], &["card", "panel", "tile"]),
];

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Signature {
    pub tag: String,
    pub classes: Vec<String>,
    pub role: Option<String>,
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Scored {
    pub score: f64,
    pub class: f64,
    pub name: f64,
    pub tag: bool,
    pub named: bool,
}

pub struct Candidate<'c> {
    pub key: &'c str,
    pub tokens: &'c [String],
    pub tag: Option<&'c str>,
    pub features: &'c BTreeSet<String>,
    pub used_by: u32,
    pub scope: Scope,
}

pub struct Request {
    pub words: BTreeSet<String>,
    pub named: BTreeSet<String>,
    pub features: BTreeSet<String>,
    pub tag: String,
}

#[must_use]
pub fn squashed(text: &str) -> String {
    text.chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect()
}

#[must_use]
pub fn name_tokens(name: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut previous_lower = false;
    for c in name.chars() {
        if !c.is_ascii_alphanumeric() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            previous_lower = false;
            continue;
        }
        if c.is_ascii_uppercase() && previous_lower && !current.is_empty() {
            tokens.push(std::mem::take(&mut current));
        }
        previous_lower = c.is_ascii_lowercase() || c.is_ascii_digit();
        current.push(c.to_ascii_lowercase());
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

#[must_use]
pub fn class_features<S: AsRef<str>>(classes: &[S]) -> BTreeSet<String> {
    let mut features = BTreeSet::new();
    for class in classes {
        let class = class.as_ref();
        features.insert(class.to_owned());
        if let Some((family, _)) = class.rsplit_once('-')
            && !family.is_empty()
        {
            features.insert(family.to_owned());
        }
    }
    features
}

fn words_of(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
}

fn expand(words: &mut BTreeSet<String>) {
    let found: Vec<&str> = SEMANTIC
        .iter()
        .filter(|(triggers, _)| triggers.iter().any(|trigger| words.contains(*trigger)))
        .flat_map(|(_, tokens)| tokens.iter().copied())
        .collect();
    words.extend(found.into_iter().map(str::to_owned));
}

#[must_use]
pub fn request(prompt: &str, signature: &Signature) -> Request {
    let prompt_words: Vec<String> = words_of(prompt).collect();
    let mut words: BTreeSet<String> = prompt_words
        .iter()
        .filter(|word| word.len() >= MIN_WORD && !NOISE.contains(&word.as_str()))
        .cloned()
        .collect();
    let mut element: BTreeSet<String> = BTreeSet::new();
    element.insert(signature.tag.to_lowercase());
    element.extend(signature.role.iter().map(|role| role.to_lowercase()));
    for class in &signature.classes {
        element.extend(words_of(class));
    }
    element.extend(words_of(&signature.text).filter(|word| word.len() >= MIN_WORD));
    expand(&mut element);
    words.extend(element);
    let mut named = BTreeSet::new();
    for size in 1..=MAX_JOINED {
        for run in prompt_words.windows(size) {
            let joined = run.concat();
            if joined.len() >= MIN_WORD && !NOISE.contains(&joined.as_str()) {
                named.insert(joined);
            }
        }
    }
    Request {
        words,
        named,
        features: class_features(&signature.classes),
        tag: signature.tag.to_lowercase(),
    }
}

fn count(value: usize) -> f64 {
    f64::from(u32::try_from(value).unwrap_or(u32::MAX))
}

fn ratio(part: usize, whole: usize) -> f64 {
    if whole == 0 {
        return 0.0;
    }
    count(part) / count(whole)
}

fn jaccard(a: &BTreeSet<String>, b: &BTreeSet<String>) -> f64 {
    ratio(a.intersection(b).count(), a.union(b).count())
}

#[must_use]
pub fn popularity(used_by: u32) -> f64 {
    ((1.0 + f64::from(used_by)).ln() / POPULAR_SCALE.ln()).min(1.0)
}

#[must_use]
pub fn score(request: &Request, candidate: &Candidate<'_>) -> Scored {
    let named = request.named.contains(candidate.key);
    let name = if named {
        1.0
    } else {
        let hits = candidate
            .tokens
            .iter()
            .filter(|token| request.words.contains(*token))
            .count();
        ratio(hits, candidate.tokens.len())
    };
    let class = jaccard(&request.features, candidate.features);
    let tag = candidate.tag == Some(request.tag.as_str());
    let score = CLASS_WEIGHT * class
        + NAME_WEIGHT * name
        + if tag { TAG_WEIGHT } else { 0.0 }
        + POPULAR_WEIGHT * popularity(candidate.used_by)
        + candidate.scope.bonus()
        + if named { NAMED_BONUS } else { 0.0 };
    Scored {
        score,
        class,
        name,
        tag,
        named,
    }
}

#[must_use]
pub fn kept(scored: &Scored) -> bool {
    scored.named
        || (scored.score >= MIN_SCORE && (scored.class >= MIN_CLASS || scored.name >= MIN_NAME))
}

#[cfg(test)]
mod tests {
    use gjd_core::components::Markup;

    use super::{
        Candidate, Scope, Signature, class_features, kept, name_tokens, popularity, request, score,
        squashed,
    };

    fn root(tag: &str, classes: &str) -> Markup {
        Markup {
            tag: tag.to_owned(),
            classes: classes.split_whitespace().map(str::to_owned).collect(),
            role: None,
        }
    }

    fn inline_error() -> Signature {
        Signature {
            tag: "p".to_owned(),
            classes: vec!["mt-2".into(), "text-xs".into(), "text-red-500".into()],
            role: None,
            text: "Enter a valid email address.".to_owned(),
        }
    }

    struct Choice {
        name: &'static str,
        root: Markup,
        used_by: u32,
        scope: Scope,
    }

    fn ranked(prompt: &str, signature: &Signature, options: &[Choice]) -> Vec<&'static str> {
        let wanted = request(prompt, signature);
        let mut scored: Vec<(f64, &'static str)> = options
            .iter()
            .filter_map(|option| {
                let tokens = name_tokens(option.name);
                let key = squashed(option.name);
                let features = class_features(&option.root.classes);
                let result = score(
                    &wanted,
                    &Candidate {
                        key: &key,
                        tokens: &tokens,
                        tag: Some(option.root.tag.as_str()),
                        features: &features,
                        used_by: option.used_by,
                        scope: option.scope,
                    },
                );
                kept(&result).then_some((result.score, option.name))
            })
            .collect();
        scored.sort_by(|a, b| b.0.total_cmp(&a.0));
        scored.into_iter().map(|(_, name)| name).collect()
    }

    fn library() -> Vec<Choice> {
        vec![
            Choice {
                name: "ErrorMessage",
                root: root("p", "mt-1 text-sm text-red-700"),
                used_by: 1,
                scope: Scope::Shared,
            },
            Choice {
                name: "FieldHint",
                root: root("p", "mt-1 text-xs text-espresso/70"),
                used_by: 0,
                scope: Scope::Shared,
            },
            Choice {
                name: "RewardsHint",
                root: root("p", "mt-1 text-xs text-espresso/70"),
                used_by: 0,
                scope: Scope::SameFeature,
            },
            Choice {
                name: "Note",
                root: root("p", "text-sm italic"),
                used_by: 1,
                scope: Scope::Shared,
            },
            Choice {
                name: "OrderButton",
                root: root(
                    "button",
                    "rounded-lg bg-brand px-6 py-3 font-medium text-white",
                ),
                used_by: 1,
                scope: Scope::Shared,
            },
        ]
    }

    #[test]
    fn splits_names_and_reads_class_families() {
        assert_eq!(name_tokens("ErrorMessage"), ["error", "message"]);
        assert_eq!(name_tokens("HTMLPreview2"), ["htmlpreview2"]);
        assert_eq!(name_tokens("field-error_text"), ["field", "error", "text"]);
        let features = class_features(&["text-red-700", "mt-1", "italic"]);
        assert!(features.contains("text-red"));
        assert!(features.contains("mt"));
        assert!(features.contains("italic"));
        assert!(!features.contains("text-red-500"));
    }

    #[test]
    fn finds_the_error_component_for_inline_red_text_when_the_prompt_names_nothing() {
        let prompt = "I think there's already an existing component, I want you to search it across the codebase";

        let found = ranked(prompt, &inline_error(), &library());

        assert_eq!(found.first(), Some(&"ErrorMessage"));
        assert!(!found.contains(&"Note"));
        assert!(!found.contains(&"OrderButton"));
    }

    #[test]
    fn a_name_in_the_prompt_wins_over_looks() {
        let found = ranked("swap this for the OrderButton", &inline_error(), &library());

        assert_eq!(found.first(), Some(&"OrderButton"));
    }

    #[test]
    fn the_same_feature_wins_a_tie_with_a_shared_look_alike() {
        let hint = Signature {
            tag: "p".to_owned(),
            classes: vec!["mt-1".into(), "text-xs".into(), "text-espresso/70".into()],
            role: None,
            text: "Points arrive within a day.".to_owned(),
        };

        let found = ranked("use the existing hint component", &hint, &library());

        assert_eq!(&found[..2], ["RewardsHint", "FieldHint"]);
    }

    #[test]
    fn popularity_breaks_a_tie_between_equal_look_alikes() {
        let mut options = library();
        options.retain(|option| option.name == "FieldHint");
        options.push(Choice {
            name: "FieldNote",
            root: root("p", "mt-1 text-xs text-espresso/70"),
            used_by: 9,
            scope: Scope::Shared,
        });
        let hint = Signature {
            tag: "p".to_owned(),
            classes: vec!["mt-1".into(), "text-xs".into(), "text-espresso/70".into()],
            role: None,
            text: String::new(),
        };

        assert_eq!(ranked("", &hint, &options), ["FieldNote", "FieldHint"]);
        assert!(popularity(0) < popularity(1));
        assert!((popularity(1_000) - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn a_plain_layout_box_matches_nothing() {
        let layout = Signature {
            tag: "div".to_owned(),
            classes: vec!["flex".into(), "gap-4".into()],
            role: None,
            text: String::new(),
        };

        assert_eq!(
            ranked("make it consistent", &layout, &library()),
            Vec::<&str>::new()
        );
    }
}
