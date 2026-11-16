//! The exact before/after lines a change writes, for the Code tab (FR-064).

use std::num::NonZeroU64;

use gjd_core::contracts::CodeChange;
use similar::{DiffOp, TextDiff};

#[must_use]
pub fn code_changes(file: &str, before: &str, after: &str) -> Vec<CodeChange> {
    let old_lines: Vec<&str> = before.lines().collect();
    let new_lines: Vec<&str> = after.lines().collect();
    TextDiff::from_lines(before, after)
        .grouped_ops(0)
        .iter()
        .filter(|group| group.iter().any(|op| !matches!(op, DiffOp::Equal { .. })))
        .filter_map(|group| {
            let (first, last) = (group.first()?, group.last()?);
            let old = first.old_range().start..last.old_range().end;
            let new = first.new_range().start..last.new_range().end;
            Some(CodeChange {
                file: file.to_owned(),
                line: NonZeroU64::new(u64::try_from(old.start + 1).ok()?)?,
                before: old_lines
                    .get(old)?
                    .iter()
                    .map(|line| (*line).to_owned())
                    .collect(),
                after: new_lines
                    .get(new)?
                    .iter()
                    .map(|line| (*line).to_owned())
                    .collect(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::code_changes;

    #[test]
    fn reports_each_changed_hunk_with_its_line() {
        let before = "a\nb\nc\nd\ne\n";
        let after = "a\nB\nc\nd\nE\nf\n";

        let changes = code_changes("src/x.tsx", before, after);

        let summary: Vec<_> = changes
            .iter()
            .map(|change| {
                (
                    change.line.get(),
                    change.before.clone(),
                    change.after.clone(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                (2, vec!["b".to_owned()], vec!["B".to_owned()]),
                (
                    5,
                    vec!["e".to_owned()],
                    vec!["E".to_owned(), "f".to_owned()]
                ),
            ]
        );
    }

    #[test]
    fn reports_nothing_for_identical_content() {
        assert!(code_changes("src/x.tsx", "a\r\nb\r\n", "a\r\nb\r\n").is_empty());
    }

    #[test]
    fn drops_carriage_returns_from_reported_lines() {
        let changes = code_changes("src/x.tsx", "a\r\nb\r\n", "a\r\nB\r\n");

        assert_eq!(changes[0].before, vec!["b".to_owned()]);
        assert_eq!(changes[0].after, vec!["B".to_owned()]);
    }
}
