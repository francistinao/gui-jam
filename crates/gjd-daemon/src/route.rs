use gjd_core::tailwind::PALETTE;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    R0,
    R1,
    R2,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Decision {
    pub tier: Tier,
    pub question: bool,
    pub notice: Option<&'static str>,
}

pub const EXACT_NOTICE: &str = "Exact edit — no AI needed.";
pub const MULTI_FILE_NOTICE: &str =
    "Multi-file changes work best from your CLI session; this only changes the selected file.";

const SHORT_PROMPT_WORDS: usize = 60;

const QUESTION_STARTS: [&str; 18] = [
    "what", "what's", "whats", "where", "where's", "which", "who", "why", "how", "when", "is",
    "are", "does", "do", "can", "could", "explain", "tell",
];
const EDIT_VERBS: [&str; 16] = [
    "make", "change", "set", "turn", "add", "remove", "delete", "replace", "use", "move", "give",
    "swap", "insert", "put", "fix", "update",
];
const MULTI_FILE: [&str; 7] = [
    "refactor",
    "extract",
    "rename",
    "everywhere",
    "across",
    "globally",
    "sitewide",
];
const MULTI_FILE_PHRASES: [&str; 7] = [
    "all pages",
    "every page",
    "new page",
    "new route",
    "whole app",
    "entire app",
    "other pages",
];
const STRUCTURE: [&str; 20] = [
    "add",
    "insert",
    "remove",
    "delete",
    "move",
    "reorder",
    "wrap",
    "replace",
    "swap",
    "duplicate",
    "split",
    "merge",
    "layout",
    "grid",
    "columns",
    "image",
    "icon",
    "logo",
    "illustration",
    "section",
];
const STYLE: [&str; 61] = [
    "color",
    "colour",
    "colors",
    "background",
    "fill",
    "gradient",
    "dark",
    "darker",
    "light",
    "lighter",
    "brighter",
    "muted",
    "vivid",
    "white",
    "black",
    "grey",
    "rounded",
    "round",
    "pill",
    "square",
    "sharp",
    "radius",
    "corner",
    "corners",
    "border",
    "outline",
    "stroke",
    "shadow",
    "glow",
    "elevation",
    "soft",
    "softer",
    "stronger",
    "flat",
    "bold",
    "bolder",
    "font",
    "text",
    "bigger",
    "smaller",
    "larger",
    "size",
    "italic",
    "uppercase",
    "weight",
    "spacing",
    "padding",
    "margin",
    "tighter",
    "looser",
    "wider",
    "narrower",
    "taller",
    "shorter",
    "opacity",
    "transparent",
    "hover",
    "contrast",
    "subtle",
    "minimal",
    "modern",
];
const MOTION: [&str; 9] = [
    "animate",
    "animation",
    "transition",
    "fade",
    "bounce",
    "pulse",
    "spin",
    "slide",
    "wiggle",
];

fn words(prompt: &str) -> Vec<String> {
    prompt
        .to_lowercase()
        .split(|c: char| !(c.is_alphanumeric() || c == '\'' || c == '-'))
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect()
}

fn mentions_file(prompt: &str) -> bool {
    prompt.split_whitespace().any(|word| {
        let word = word.trim_matches(|c: char| !(c.is_alphanumeric() || c == '.' || c == '/'));
        word.contains('/')
            || word.rsplit_once('.').is_some_and(|(stem, ext)| {
                !stem.is_empty()
                    && matches!(
                        ext,
                        "tsx"
                            | "ts"
                            | "jsx"
                            | "js"
                            | "css"
                            | "svg"
                            | "png"
                            | "jpg"
                            | "jpeg"
                            | "webp"
                    )
            })
    })
}

fn is_question(prompt: &str, words: &[String]) -> bool {
    let asks = prompt.trim_end().ends_with('?')
        || words
            .first()
            .is_some_and(|first| QUESTION_STARTS.contains(&first.as_str()));
    asks && !words.iter().any(|word| EDIT_VERBS.contains(&word.as_str()))
}

#[must_use]
pub fn classify(prompt: &str, exact: bool, force_ai: bool, visual: bool) -> Decision {
    let words = words(prompt);
    let question = is_question(prompt, &words);
    let lowered = prompt.to_lowercase();
    let decision = |tier, notice| Decision {
        tier,
        question,
        notice,
    };
    if visual {
        return decision(Tier::R2, None);
    }
    if exact && !force_ai && !question {
        return decision(Tier::R0, Some(EXACT_NOTICE));
    }
    let has = |list: &[&str]| words.iter().any(|word| list.contains(&word.as_str()));
    if has(&MULTI_FILE)
        || MULTI_FILE_PHRASES
            .iter()
            .any(|phrase| lowered.contains(phrase))
    {
        return decision(Tier::R2, Some(MULTI_FILE_NOTICE));
    }
    let short = words.len() < SHORT_PROMPT_WORDS;
    let styled = has(&STYLE) || has(&MOTION) || has(&PALETTE);
    let structural = has(&STRUCTURE) || mentions_file(prompt);
    if short && (question || (styled && !structural)) {
        decision(Tier::R1, None)
    } else {
        decision(Tier::R2, None)
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::{EXACT_NOTICE, MULTI_FILE_NOTICE, Tier, classify};

    #[test]
    fn routes_each_kind_of_request() {
        let cases = [
            ("make it blue and pill-shaped", true, false, Tier::R0, false),
            ("make it blue and pill-shaped", true, true, Tier::R1, false),
            (
                "make it blue with a soft shadow",
                false,
                false,
                Tier::R1,
                false,
            ),
            (
                "what's the path of this image?",
                false,
                false,
                Tier::R1,
                true,
            ),
            (
                "Explain how this card gets its spacing",
                false,
                false,
                Tier::R1,
                true,
            ),
            ("can you make it blue?", false, false, Tier::R1, false),
            (
                "make this feel premium and trustworthy",
                false,
                false,
                Tier::R2,
                false,
            ),
            (
                "use the image from the navbar here",
                false,
                false,
                Tier::R2,
                false,
            ),
            (
                "replace it with src/assets/cup.svg",
                false,
                false,
                Tier::R2,
                false,
            ),
            (
                "add a small icon before the label",
                false,
                false,
                Tier::R2,
                false,
            ),
        ];
        for (prompt, exact, force_ai, tier, question) in cases {
            let decision = classify(prompt, exact, force_ai, false);
            assert_eq!(
                (decision.tier, decision.question),
                (tier, question),
                "{prompt}"
            );
        }
    }

    #[test]
    fn explains_exact_and_multi_file_routes() {
        assert_eq!(
            classify("blue", true, false, false).notice,
            Some(EXACT_NOTICE)
        );
        let decision = classify("refactor this into a shared Button", false, false, false);
        assert_eq!(
            (decision.tier, decision.notice),
            (Tier::R2, Some(MULTI_FILE_NOTICE))
        );
        assert_eq!(classify("what is this?", true, false, false).tier, Tier::R1);
    }

    #[test]
    fn sends_sketches_to_the_standard_tier_even_when_the_prompt_is_exact() {
        let decision = classify("make it blue", true, false, true);
        assert_eq!((decision.tier, decision.notice), (Tier::R2, None));
    }

    #[test]
    fn decides_well_within_a_millisecond() {
        let prompt =
            "make the card a little softer with rounded corners and a gentle shadow ".repeat(4);
        let started = Instant::now();
        for _ in 0..100 {
            let _ = classify(&prompt, false, false, false);
        }
        assert!(started.elapsed().as_micros() / 100 < 1_000);
    }
}
