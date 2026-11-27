use std::collections::BTreeSet;
use std::fs;

use gjd_core::content_hash;
use gjd_core::journal::{CommitError, EntryMeta, FileChange, Journal};
use gjd_core::merge::revert;
use gjd_core::policy::ProjectRoot;

const PAGE: &str = "src/Page.tsx";
const CARD: &str = "src/Card.tsx";
const BASE: &str = "one\ntwo\nthree\nfour\nfive\nsix\n";

fn project(files: &[(&str, &str)]) -> (tempfile::TempDir, Journal) {
    let dir = tempfile::tempdir().expect("temp dir");
    fs::create_dir_all(dir.path().join("src")).expect("src dir");
    for (path, content) in files {
        fs::write(dir.path().join(path), content).expect("fixture");
    }
    let journal = Journal::open(ProjectRoot::new(dir.path()).expect("root")).expect("journal");
    (dir, journal)
}

fn read(dir: &tempfile::TempDir, path: &str) -> String {
    fs::read_to_string(dir.path().join(path)).expect("readable")
}

fn exists(dir: &tempfile::TempDir, path: &str) -> bool {
    dir.path().join(path).exists()
}

fn edit(dir: &tempfile::TempDir, path: &str, to: &str) -> FileChange {
    FileChange::edit(path, content_hash(read(dir, path).as_bytes()), to)
}

fn meta(component: &str, detail: &str, page: &str) -> EntryMeta {
    EntryMeta {
        component: Some(component.to_owned()),
        detail: Some(detail.to_owned()),
        page_url: Some(page.to_owned()),
        ..EntryMeta::default()
    }
}

fn change(journal: &Journal, dir: &tempfile::TempDir, path: &str, to: &str, name: &str) -> String {
    journal
        .commit_with(
            &[edit(dir, path, to)],
            "finetune",
            name,
            meta(name, "detail", "http://localhost/"),
        )
        .expect("committed")
}

const MERGES: &[(&str, &str, &str, &str, &str)] = &[
    (
        "a later edit on another line survives",
        "one\nTWO\nthree\nfour\nfive\nsix\n",
        "one\nTWO\nthree\nfour\nFIVE\nsix\n",
        BASE,
        "one\ntwo\nthree\nfour\nFIVE\nsix\n",
    ),
    (
        "a later edit on the next line merges",
        "one\nTWO\nthree\nfour\nfive\nsix\n",
        "one\nTWO\nTHREE\nfour\nfive\nsix\n",
        BASE,
        "one\ntwo\nTHREE\nfour\nfive\nsix\n",
    ),
    (
        "a later insertion elsewhere survives",
        "one\nTWO\nthree\nfour\nfive\nsix\n",
        "one\nTWO\nthree\nfour\nfive\nsix\nseven\n",
        BASE,
        "one\ntwo\nthree\nfour\nfive\nsix\nseven\n",
    ),
    (
        "crlf line endings are kept",
        "one\r\nTWO\r\nthree\r\n",
        "one\r\nTWO\r\nTHREE\r\n",
        "one\r\ntwo\r\nthree\r\n",
        "one\r\ntwo\r\nTHREE\r\n",
    ),
    (
        "a missing final newline is kept",
        "one\nTWO\nthree",
        "ONE\nTWO\nthree",
        "one\ntwo\nthree",
        "ONE\ntwo\nthree",
    ),
    (
        "multibyte text is kept",
        "오늘\n추천 라떼\n가격\n",
        "오늘의\n추천 라떼\n가격\n",
        "오늘\n추천\n가격\n",
        "오늘의\n추천\n가격\n",
    ),
    (
        "no later change gives back the original",
        "one\nTWO\nthree\n",
        "one\nTWO\nthree\n",
        "one\ntwo\nthree\n",
        "one\ntwo\nthree\n",
    ),
];

#[test]
fn reverting_merges_around_later_edits() {
    let failures: Vec<String> = MERGES
        .iter()
        .filter_map(|(name, ancestor, current, target, expected)| {
            let got = revert(ancestor, current, target);
            (got.as_deref() != Ok(*expected)).then(|| format!("{name}: {got:?}"))
        })
        .collect();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn reverting_refuses_lines_a_later_change_rewrote() {
    let same_line = revert(
        "one\nTWO\nthree\n",
        "one\nTwo!\nthree\n",
        "one\ntwo\nthree\n",
    );
    let inserted_inside = revert(
        "one\nTWO\nthree\n",
        "one\nTWO\nextra\nthree\n",
        "one\ntwo\nthree\n",
    );
    let both_insert_at_one_point = revert("a\nc\n", "a\nlater\nc\n", "a\nmine\nc\n");

    assert!(same_line.is_err(), "{same_line:?}");
    assert!(
        both_insert_at_one_point.is_err(),
        "{both_insert_at_one_point:?}"
    );
    assert!(
        inserted_inside.as_deref() == Ok("one\ntwo\nextra\nthree\n") || inserted_inside.is_err(),
        "{inserted_inside:?}"
    );
}

#[test]
fn undo_redo_undo_redo_lands_on_the_exact_bytes_each_time() {
    let (dir, journal) = project(&[(PAGE, BASE)]);
    let after = "one\nTWO\nthree\nfour\nfive\nsix\n";
    let id = change(&journal, &dir, PAGE, after, "Title");

    for (want_applied, expected) in [(false, BASE), (true, after), (false, BASE), (true, after)] {
        let flipped = journal.flip(&id, want_applied).expect("flipped");
        assert_eq!(flipped.of, id);
        assert_eq!(read(&dir, PAGE), expected);
    }
    assert!(matches!(
        journal.flip(&id, true),
        Err(CommitError::NotUndone(_))
    ));
}

#[test]
fn undoing_an_older_change_keeps_a_newer_one_in_the_same_file() {
    let (dir, journal) = project(&[(PAGE, BASE)]);
    let older = change(
        &journal,
        &dir,
        PAGE,
        "ONE\ntwo\nthree\nfour\nfive\nsix\n",
        "Older",
    );
    change(
        &journal,
        &dir,
        PAGE,
        "ONE\ntwo\nthree\nfour\nfive\nSIX\n",
        "Newer",
    );

    journal.flip(&older, false).expect("undone");
    assert_eq!(read(&dir, PAGE), "one\ntwo\nthree\nfour\nfive\nSIX\n");
    journal.flip(&older, true).expect("redone");
    assert_eq!(read(&dir, PAGE), "ONE\ntwo\nthree\nfour\nfive\nSIX\n");
}

#[test]
fn a_newer_change_on_the_same_line_blocks_undo_names_it_and_writes_nothing() {
    let (dir, journal) = project(&[(PAGE, BASE)]);
    let older = change(
        &journal,
        &dir,
        PAGE,
        "one\nTWO\nthree\nfour\nfive\nsix\n",
        "Older",
    );
    let newer = change(
        &journal,
        &dir,
        PAGE,
        "one\nTwo!\nthree\nfour\nfive\nsix\n",
        "Newer",
    );
    let before = read(&dir, PAGE);

    let result = journal.flip(&older, false);

    match result {
        Err(CommitError::Overlap {
            path,
            blockers,
            lines,
        }) => {
            assert_eq!(path, PAGE);
            assert_eq!(blockers.len(), 1, "{blockers:?}");
            assert!(blockers[0].contains("Newer"), "{blockers:?}");
            assert_eq!(lines, [(2, 2)]);
        }
        other => panic!("expected an overlap, got {other:?}"),
    }
    assert_eq!(read(&dir, PAGE), before);
    journal.flip(&newer, false).expect("newer undone first");
    journal.flip(&older, false).expect("then older");
    assert_eq!(read(&dir, PAGE), BASE);
}

#[test]
fn a_developer_edit_elsewhere_does_not_block_undo_and_survives_it() {
    let (dir, journal) = project(&[(PAGE, BASE)]);
    let id = change(
        &journal,
        &dir,
        PAGE,
        "one\nTWO\nthree\nfour\nfive\nsix\n",
        "Title",
    );
    fs::write(
        dir.path().join(PAGE),
        "one\nTWO\nthree\nfour\nfive\nsix\n// dev\n",
    )
    .expect("dev edit");

    journal.flip(&id, false).expect("undone");

    assert_eq!(
        read(&dir, PAGE),
        "one\ntwo\nthree\nfour\nfive\nsix\n// dev\n"
    );
}

#[test]
fn a_developer_edit_on_the_same_line_blocks_undo_without_naming_a_change() {
    let (dir, journal) = project(&[(PAGE, BASE)]);
    let id = change(
        &journal,
        &dir,
        PAGE,
        "one\nTWO\nthree\nfour\nfive\nsix\n",
        "Title",
    );
    let developer = "one\nTwo, by hand\nthree\nfour\nfive\nsix\n";
    fs::write(dir.path().join(PAGE), developer).expect("dev edit");

    let result = journal.flip(&id, false);

    match result {
        Err(CommitError::Overlap { blockers, .. }) => assert!(blockers.is_empty(), "{blockers:?}"),
        Err(CommitError::Conflict { .. }) => {}
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert_eq!(read(&dir, PAGE), developer);
}

#[test]
fn undoing_a_created_file_the_developer_edited_keeps_their_work() {
    let (dir, journal) = project(&[]);
    let id = journal
        .commit_with(
            &[FileChange::create(CARD, "export const Card = 1;\n")],
            "ai",
            "Card",
            EntryMeta::default(),
        )
        .expect("created");
    fs::write(dir.path().join(CARD), "export const Card = 2;\n").expect("dev edit");

    assert!(journal.flip(&id, false).is_err());
    assert_eq!(read(&dir, CARD), "export const Card = 2;\n");
}

#[test]
fn a_created_file_is_removed_on_undo_and_redo_refuses_to_overwrite_a_new_one() {
    let (dir, journal) = project(&[]);
    let id = journal
        .commit_with(
            &[FileChange::create(CARD, "export const Card = 1;\n")],
            "ai",
            "Card",
            EntryMeta::default(),
        )
        .expect("created");

    journal.flip(&id, false).expect("undone");
    assert!(!exists(&dir, CARD));
    fs::write(dir.path().join(CARD), "a different card\n").expect("dev file");

    assert!(journal.flip(&id, true).is_err());
    assert_eq!(read(&dir, CARD), "a different card\n");
}

#[test]
fn one_file_that_overlaps_keeps_every_other_file_unwritten() {
    let (dir, journal) = project(&[(PAGE, BASE), (CARD, BASE)]);
    let both = journal
        .commit_with(
            &[
                edit(&dir, PAGE, "one\nTWO\nthree\nfour\nfive\nsix\n"),
                edit(&dir, CARD, "one\nTWO\nthree\nfour\nfive\nsix\n"),
            ],
            "ai",
            "Both",
            EntryMeta::default(),
        )
        .expect("committed");
    change(
        &journal,
        &dir,
        CARD,
        "one\nTwo!\nthree\nfour\nfive\nsix\n",
        "Card later",
    );
    let page = read(&dir, PAGE);
    let card = read(&dir, CARD);

    assert!(matches!(
        journal.flip(&both, false),
        Err(CommitError::Overlap { .. })
    ));
    assert_eq!(read(&dir, PAGE), page);
    assert_eq!(read(&dir, CARD), card);
}

#[test]
fn history_pages_newest_first_without_gaps_or_repeats() {
    let (dir, journal) = project(&[(PAGE, BASE)]);
    let mut ids = Vec::new();
    for round in 0..7 {
        let next = format!("{}{round}\n", read(&dir, PAGE));
        ids.push(change(
            &journal,
            &dir,
            PAGE,
            &next,
            &format!("Change {round}"),
        ));
    }

    let mut seen = Vec::new();
    let mut before: Option<String> = None;
    loop {
        let (rows, more) = journal.history(None, before.as_deref(), 3).expect("listed");
        seen.extend(rows.iter().map(|row| row.id.clone()));
        before = rows.last().map(|row| row.id.clone());
        if !more {
            break;
        }
    }

    ids.reverse();
    assert_eq!(seen, ids);
}

#[test]
fn history_filters_by_page_and_marks_undone_rows() {
    let (dir, journal) = project(&[(PAGE, BASE)]);
    let home = journal
        .commit_with(
            &[edit(&dir, PAGE, "one\nTWO\nthree\nfour\nfive\nsix\n")],
            "finetune",
            "Home",
            meta("Hero", "Fill", "http://localhost/"),
        )
        .expect("home");
    journal
        .commit_with(
            &[edit(&dir, PAGE, "one\nTWO\nthree\nfour\nfive\nSIX\n")],
            "finetune",
            "Menu",
            meta("Menu", "Fill", "http://localhost/menu"),
        )
        .expect("menu");
    journal.flip(&home, false).expect("undone");

    let (rows, more) = journal
        .history(Some("http://localhost/"), None, 10)
        .expect("listed");

    assert!(!more);
    assert_eq!(
        rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
        [home.as_str()]
    );
    assert!(!rows[0].applied);
    let (all, _) = journal.history(None, None, 10).expect("listed");
    assert_eq!(all.len(), 2);
    let undo_rows: BTreeSet<&str> = all.iter().map(|row| row.origin.as_str()).collect();
    assert!(!undo_rows.contains("undo"), "{undo_rows:?}");
}

#[test]
fn entries_committed_without_meta_still_list() {
    let (dir, journal) = project(&[(PAGE, BASE)]);
    let id = journal
        .commit(
            &[edit(&dir, PAGE, "one\nTWO\nthree\nfour\nfive\nsix\n")],
            "finetune",
            "old style",
        )
        .expect("committed");

    let (rows, _) = journal.history(None, None, 10).expect("listed");

    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, id);
    assert_eq!(rows[0].meta, EntryMeta::default());
    journal.flip(&id, false).expect("still undoable");
}
