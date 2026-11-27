use std::ops::Range;

use similar::{Algorithm, DiffTag, capture_diff_slices};

#[derive(Debug, Clone, PartialEq, Eq)]
struct Hunk<'t> {
    old: Range<usize>,
    new: Range<usize>,
    lines: &'t [&'t str],
}

fn lines(text: &str) -> Vec<&str> {
    text.split_inclusive('\n').collect()
}

fn hunks<'t>(old: &[&str], new: &'t [&'t str]) -> Vec<Hunk<'t>> {
    let mut found: Vec<Hunk<'t>> = Vec::new();
    for op in capture_diff_slices(Algorithm::Myers, old, new) {
        let (tag, old_range, new_range) = op.as_tag_tuple();
        if tag == DiffTag::Equal {
            continue;
        }
        match found.last_mut() {
            Some(last) if last.old.end == old_range.start && last.new.end == new_range.start => {
                last.old.end = old_range.end;
                last.new.end = new_range.end;
                last.lines = &new[last.new.clone()];
            }
            _ => found.push(Hunk {
                lines: &new[new_range.clone()],
                old: old_range,
                new: new_range,
            }),
        }
    }
    found
}

fn clash(a: &Range<usize>, b: &Range<usize>) -> bool {
    let a_insert = a.is_empty();
    let b_insert = b.is_empty();
    if a_insert && b_insert {
        return a.start == b.start;
    }
    if a_insert {
        return b.start < a.start && a.start < b.end;
    }
    if b_insert {
        return a.start < b.start && b.start < a.end;
    }
    a.start < b.end && b.start < a.end
}

pub fn revert(ancestor: &str, current: &str, target: &str) -> Result<String, Vec<Range<usize>>> {
    let base = lines(ancestor);
    let mine = lines(target);
    let theirs = lines(current);
    let undo = hunks(&base, &mine);
    let later = hunks(&base, &theirs);
    let clashes: Vec<Range<usize>> = later
        .iter()
        .filter(|hunk| undo.iter().any(|own| clash(&own.old, &hunk.old)))
        .map(|hunk| hunk.new.clone())
        .collect();
    if !clashes.is_empty() {
        return Err(clashes);
    }
    let mut all: Vec<&Hunk<'_>> = undo.iter().chain(later.iter()).collect();
    all.sort_by_key(|hunk| (hunk.old.start, hunk.old.end));
    let mut merged = String::with_capacity(current.len());
    let mut at = 0;
    for hunk in all {
        merged.extend(base[at..hunk.old.start].iter().copied());
        merged.extend(hunk.lines.iter().copied());
        at = hunk.old.end;
    }
    merged.extend(base[at..].iter().copied());
    Ok(merged)
}

#[must_use]
pub fn map_line(from: &str, to: &str, line: usize) -> usize {
    let old = lines(from);
    let new = lines(to);
    for op in capture_diff_slices(Algorithm::Myers, &old, &new) {
        let (tag, old_range, new_range) = op.as_tag_tuple();
        if old_range.contains(&line) {
            return if tag == DiffTag::Equal {
                new_range.start + (line - old_range.start)
            } else {
                new_range.start
            };
        }
    }
    line.min(new.len())
}

#[must_use]
pub fn changed_lines(before: &str, after: &str) -> Vec<Range<usize>> {
    let old = lines(before);
    let new = lines(after);
    hunks(&old, &new).into_iter().map(|hunk| hunk.new).collect()
}

#[cfg(test)]
mod tests {
    use super::{changed_lines, map_line, revert};

    const BASE: &str = "a\nb\nc\nd\ne\nf\n";

    #[test]
    fn undoes_one_change_and_keeps_a_later_one_elsewhere() {
        let after_first = "a\nB\nc\nd\ne\nf\n";
        let after_second = "a\nB\nc\nd\nE\nf\n";

        let merged = revert(after_first, after_second, BASE).expect("no overlap");

        assert_eq!(merged, "a\nb\nc\nd\nE\nf\n");
    }

    #[test]
    fn refuses_when_a_later_change_touched_the_same_lines() {
        let after_first = "a\nB\nc\nd\ne\nf\n";
        let later = "a\nBB\nc\nd\ne\nf\n";

        assert_eq!(
            revert(after_first, later, BASE).map_err(|clashes| clashes.len()),
            Err(1)
        );
    }

    #[test]
    fn neighbouring_lines_of_different_changes_merge() {
        let after_first = "a\nB\nc\nd\ne\nf\n";
        let later = "a\nB\nC\nd\ne\nf\n";

        assert_eq!(
            revert(after_first, later, BASE).expect("touching hunks merge"),
            "a\nb\nC\nd\ne\nf\n"
        );
    }

    #[test]
    fn insertions_inside_or_at_the_same_point_as_the_change_conflict() {
        let replaced = "a\nX\nY\nZ\ne\nf\n";
        let inside = "a\nX\nY\nmid\nZ\ne\nf\n";
        assert!(revert(replaced, inside, BASE).is_err());

        let above = "a\ntop\nX\nY\nZ\ne\nf\n";
        assert_eq!(
            revert(replaced, above, BASE).expect("an insertion at the edge merges"),
            "a\ntop\nb\nc\nd\ne\nf\n"
        );

        let removed = "a\nb\nc\n";
        let with_x = "a\nb\nx\nc\n";
        let later = "a\nb\ny\nc\n";
        assert!(revert(removed, later, with_x).is_err());
    }

    #[test]
    fn keeps_crlf_and_unicode_byte_for_byte() {
        let base = "첫째\r\n둘째\r\n셋째\r\n넷째\r\n";
        let first = "첫째\r\n둘째!\r\n셋째\r\n넷째\r\n";
        let later = "첫째\r\n둘째!\r\n셋째\r\n넷째 끝\r\n";

        assert_eq!(
            revert(first, later, base).expect("separate lines"),
            "첫째\r\n둘째\r\n셋째\r\n넷째 끝\r\n"
        );
    }

    #[test]
    fn a_file_without_a_final_newline_survives() {
        let base = "a\nb\nc";
        let first = "A\nb\nc";
        let later = "A\nb\nC";

        assert_eq!(revert(first, later, base).expect("separate"), "a\nb\nC");
    }

    #[test]
    fn maps_a_line_through_inserts_and_deletes() {
        let before = "a\nb\nc\nd\n";
        let after = "x\ny\na\nc\nd\n";

        assert_eq!(map_line(before, after, 0), 2);
        assert_eq!(map_line(before, after, 1), 3);
        assert_eq!(map_line(before, after, 3), 4);
        assert_eq!(changed_lines(before, after), vec![0..2, 3..3]);
    }
}
