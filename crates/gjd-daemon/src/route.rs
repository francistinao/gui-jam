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
    pub needs_usages: bool,
    pub reuse: bool,
    pub notice: Option<&'static str>,
}

pub const EXACT_NOTICE: &str = "Exact edit. No AI needed.";
pub const MULTI_FILE_NOTICE: &str = "Changes across many files work best from your CLI session. GUIJam edits the selected file and the files it shows the AI.";

const SHORT_PROMPT_WORDS: usize = 60;

const QUESTION_STARTS: [&str; 18] = [
    "what", "what's", "whats", "where", "where's", "which", "who", "why", "how", "when", "is",
    "are", "does", "do", "can", "could", "explain", "tell",
];
const EDIT_VERBS: [&str; 16] = [
    "make", "change", "set", "turn", "add", "remove", "delete", "replace", "use", "move", "give",
    "swap", "insert", "put", "fix", "update",
];
const PLACEMENT: [&str; 10] = [
    "remove",
    "delete",
    "move",
    "relocate",
    "comment",
    "uncomment",
    "hide",
    "put",
    "place",
    "drop",
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
const SEARCH_WORD: &str = "across";
const REUSE_STRONG: [&str; 6] = [
    "existing", "reuse", "reusable", "re-use", "codebase", "atomic",
];
const REUSE_WEAK: [&str; 8] = [
    "already",
    "shared",
    "search",
    "find",
    "consistent",
    "inconsistent",
    "library",
    "global",
];
const REUSE_PHRASES: [&str; 3] = ["design system", "look for", "re use"];
const COMPONENT_WORDS: [&str; 2] = ["component", "components"];
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
pub fn classify(prompt: &str, exact: bool, force_ai: bool, rich: bool) -> Decision {
    let words = words(prompt);
    let question = is_question(prompt, &words);
    let lowered = prompt.to_lowercase();
    let has = |list: &[&str]| words.iter().any(|word| list.contains(&word.as_str()));
    let needs_usages = !question && (has(&PLACEMENT) || mentions_file(prompt));
    let reuse = has(&REUSE_STRONG)
        || REUSE_PHRASES.iter().any(|phrase| lowered.contains(phrase))
        || (has(&REUSE_WEAK) && has(&COMPONENT_WORDS));
    let decision = |tier, notice| Decision {
        tier,
        question,
        needs_usages,
        reuse,
        notice,
    };
    if rich {
        return decision(Tier::R2, None);
    }
    if exact && !force_ai && !question {
        return decision(Tier::R0, Some(EXACT_NOTICE));
    }
    let spread = words
        .iter()
        .any(|word| MULTI_FILE.contains(&word.as_str()) && !(reuse && word == SEARCH_WORD));
    if spread
        || MULTI_FILE_PHRASES
            .iter()
            .any(|phrase| lowered.contains(phrase))
    {
        return decision(Tier::R2, Some(MULTI_FILE_NOTICE));
    }
    if reuse {
        return decision(Tier::R2, None);
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
    fn sends_a_group_to_r2_even_when_one_element_would_be_an_exact_edit() {
        let exact = classify("make them blue and pill-shaped", true, false, true);
        let question = classify("which files are these in?", false, false, true);

        assert_eq!((exact.tier, exact.notice), (Tier::R2, None));
        assert_eq!((question.tier, question.question), (Tier::R2, true));
    }

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
    fn asks_for_the_files_that_render_the_element_when_the_request_moves_or_removes_it() {
        for prompt in [
            "remove this",
            "Delete this card",
            "move it to the employee dashboard",
            "comment this out",
            "hide it on the dashboard",
            "put it under the onboarding tasks",
            "use the layout from src/pages/Home.tsx",
        ] {
            let decision = classify(prompt, false, false, false);
            assert!(decision.needs_usages, "{prompt}");
            assert_eq!(decision.tier, Tier::R2, "{prompt}");
        }
        for prompt in [
            "make it blue",
            "where is this rendered?",
            "add a soft shadow",
        ] {
            assert!(
                !classify(prompt, false, false, false).needs_usages,
                "{prompt}"
            );
        }
        assert!(classify("move it below the header", false, false, true).needs_usages);
    }

    #[test]
    fn sends_sketches_to_the_standard_tier_even_when_the_prompt_is_exact() {
        let decision = classify("make it blue", true, false, true);
        assert_eq!((decision.tier, decision.notice), (Tier::R2, None));
    }

    #[test]
    fn a_request_to_reuse_an_existing_component_goes_to_the_standard_tier_without_the_cli_notice() {
        for prompt in [
            "I think there's already an existing component, I want you to search it across the codebase",
            "use the existing ErrorMessage here",
            "swap this for our reusable alert",
            "find the shared component for this",
            "match the design system",
            "this should re-use the atomic error text",
        ] {
            let decision = classify(prompt, false, false, false);
            assert!(decision.reuse, "{prompt}");
            assert_eq!(
                (decision.tier, decision.notice),
                (Tier::R2, None),
                "{prompt}"
            );
        }
    }

    #[test]
    fn spreading_a_change_across_files_still_suggests_the_cli() {
        for prompt in [
            "refactor this across the codebase to use the existing alert",
            "rename it everywhere",
            "make the buttons consistent across all pages",
            "apply this across the app",
        ] {
            let decision = classify(prompt, false, false, false);
            assert_eq!(decision.notice, Some(MULTI_FILE_NOTICE), "{prompt}");
        }
    }

    #[test]
    fn everyday_words_alone_do_not_ask_for_reuse() {
        for prompt in [
            "it's already blue, make it red",
            "make it consistent with the header",
            "find a nicer shade of green",
        ] {
            let decision = classify(prompt, false, false, false);
            assert!(!decision.reuse, "{prompt}");
        }
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
