use gjd_daemon::html_text::{colors_in, scan, styles};

const MIXED: &str = ".a::after{content:\"→ ✓ 한글 😀\"}.b{color:rgb(1,2,3);background:#FFF;border-color:hsl(1 2% 3%)}é#";

#[test]
fn colors_right_after_text_of_every_utf8_width_are_read() {
    let cases = [
        ("é rgb(1,2,3)", vec!["rgb(1,2,3)"]),
        ("→rgb(1,2,3)", vec!["rgb(1,2,3)"]),
        ("😀 hsl(10 20% 30%)", vec!["hsl(10 20% 30%)"]),
        ("한글#ABC", vec!["#aabbcc"]),
        ("#한글 #0f0", vec!["#00ff00"]),
        ("\"✓\" RGBA(0, 0, 0, .5)", vec!["rgba(0, 0, 0, .5)"]),
        ("✓✓✓", vec![]),
    ];
    for (value, expected) in cases {
        assert_eq!(colors_in(value), expected, "{value}");
    }
}

#[test]
fn no_cut_of_a_mixed_script_stylesheet_panics() {
    for (at, _) in MIXED.char_indices() {
        assert!(colors_in(&MIXED[..at]).len() <= 3, "prefix up to {at}");
        assert!(colors_in(&MIXED[at..]).len() <= 3, "suffix from {at}");
    }
}

#[test]
fn a_stylesheet_with_non_ascii_content_still_ranks_its_colors() {
    let found =
        styles(".a::after{content:\"→\"}.b{color:rgb(1,2,3)}.c{color:rgb(1,2,3)}.d{color:#FFF}");

    assert_eq!(
        found.colors,
        vec![("rgb(1,2,3)".to_owned(), 2), ("#ffffff".to_owned(), 1)]
    );
}

#[test]
fn a_page_with_korean_text_and_arrow_css_yields_its_colors() {
    let html = "<html><head><title>가이드</title><style>.x::before{content:\"→\"}.y{background:oklch(0.7 0.1 30)}</style></head><body><h1>한글 제목</h1><p>본문 ✓</p></body></html>";

    let page = scan(html);

    assert_eq!(page.title.as_deref(), Some("가이드"));
    assert_eq!(
        styles(&page.css).colors,
        vec![("oklch(0.7 0.1 30)".to_owned(), 1)]
    );
}
