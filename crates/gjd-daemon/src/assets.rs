use image_webp::{ColorType, WebPEncoder};
use resvg::{tiny_skia, usvg};

pub const DEFAULT_DIR: &str = "src/assets/icons";
const DEFAULT_WEBP_WIDTH: u16 = 128;
const MIN_WEBP_WIDTH: u16 = 16;
const MAX_WEBP_WIDTH: u16 = 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetFile {
    pub path: String,
    pub content: Vec<u8>,
    pub preview: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Svg,
    Webp,
}

impl Format {
    fn extension(self) -> &'static str {
        match self {
            Self::Svg => "svg",
            Self::Webp => "webp",
        }
    }
}

#[must_use]
pub fn assets_dir(files: &[String]) -> String {
    let has = |dir: &str| {
        files
            .iter()
            .any(|file| file.starts_with(&format!("{dir}/")))
    };
    if has("src/assets/icons") {
        DEFAULT_DIR.to_owned()
    } else if has("src/icons") {
        "src/icons".to_owned()
    } else {
        DEFAULT_DIR.to_owned()
    }
}

#[must_use]
pub fn import_path(from_file: &str, target: &str) -> String {
    let from: Vec<&str> = from_file.split('/').collect();
    let from_dir = &from[..from.len().saturating_sub(1)];
    let to: Vec<&str> = target.split('/').collect();
    let common = from_dir.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let rest = to[common..].join("/");
    match from_dir.len() - common {
        0 => format!("./{rest}"),
        ups => format!("{}{rest}", "../".repeat(ups)),
    }
}

#[must_use]
pub fn prompt_note(file: &str, dir: &str) -> String {
    format!(
        "\n<assets-folder path=\"{dir}\">\nAn asset named cup-icon with format svg is saved as {dir}/cup-icon.svg; from {file} import it as \"{}\".\n</assets-folder>\n",
        import_path(file, &format!("{dir}/cup-icon.svg"))
    )
}

pub fn prepare(
    name: &str,
    format: Format,
    svg: &str,
    width: Option<u16>,
    dir: &str,
    existing: &[String],
) -> Result<AssetFile, String> {
    let tree = usvg::Tree::from_str(svg, &usvg::Options::default())
        .map_err(|error| format!("Its {name} image is not valid SVG: {error}."))?;
    let path = format!("{dir}/{name}.{}", format.extension());
    if existing.contains(&path) {
        return Err(format!("{path} already exists."));
    }
    let content = match format {
        Format::Svg => svg.as_bytes().to_vec(),
        Format::Webp => rasterize(&tree, width.unwrap_or(DEFAULT_WEBP_WIDTH))?,
    };
    Ok(AssetFile {
        path,
        content,
        preview: svg.to_owned(),
    })
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn height_for(width: u16, size: usvg::Size) -> u32 {
    let height = f32::from(width) * size.height() / size.width();
    height.ceil().clamp(1.0, f32::from(MAX_WEBP_WIDTH) * 4.0) as u32
}

pub fn rasterize(tree: &usvg::Tree, width: u16) -> Result<Vec<u8>, String> {
    let width = width.clamp(MIN_WEBP_WIDTH, MAX_WEBP_WIDTH);
    let size = tree.size();
    let height = height_for(width, size);
    let mut pixmap = tiny_skia::Pixmap::new(u32::from(width), height)
        .ok_or_else(|| "The image has no size.".to_owned())?;
    let scale = f32::from(width) / size.width();
    resvg::render(
        tree,
        tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    let rgba: Vec<u8> = pixmap
        .pixels()
        .iter()
        .flat_map(|pixel| {
            let color = pixel.demultiply();
            [color.red(), color.green(), color.blue(), color.alpha()]
        })
        .collect();
    let mut webp = Vec::new();
    WebPEncoder::new(&mut webp)
        .encode(&rgba, u32::from(width), height, ColorType::Rgba8)
        .map_err(|error| error.to_string())?;
    Ok(webp)
}

#[cfg(test)]
mod tests {
    use super::{AssetFile, Format, assets_dir, import_path, prepare};

    const CUP: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z" fill="#3b2418"/></svg>"##;

    #[test]
    fn chooses_the_icons_folder_and_relative_imports() {
        let none: Vec<String> = Vec::new();
        let icons = vec!["src/icons/x.svg".to_owned()];
        assert_eq!(assets_dir(&none), "src/assets/icons");
        assert_eq!(assets_dir(&icons), "src/icons");
        assert_eq!(
            import_path("src/App.tsx", "src/assets/icons/cup.svg"),
            "./assets/icons/cup.svg"
        );
        assert_eq!(
            import_path("src/components/OrderButton.tsx", "src/assets/icons/cup.svg"),
            "../assets/icons/cup.svg"
        );
    }

    #[test]
    fn keeps_svg_as_written_and_renders_webp() {
        let svg = prepare("cup", Format::Svg, CUP, None, "src/assets/icons", &[]).expect("svg");
        assert_eq!(
            svg,
            AssetFile {
                path: "src/assets/icons/cup.svg".to_owned(),
                content: CUP.as_bytes().to_vec(),
                preview: CUP.to_owned(),
            }
        );

        let webp = prepare("cup", Format::Webp, CUP, Some(64), "public", &[]).expect("webp");
        assert_eq!(webp.path, "public/cup.webp");
        assert_eq!(&webp.content[..4], b"RIFF");
        assert_eq!(&webp.content[8..12], b"WEBP");
        assert_eq!(webp.preview, CUP);
    }

    #[test]
    fn refuses_broken_svg_and_existing_files() {
        let broken = prepare("cup", Format::Svg, "<svg", None, "src", &[]).expect_err("broken");
        assert!(
            broken.starts_with("Its cup image is not valid SVG"),
            "{broken}"
        );
        let taken = prepare(
            "cup",
            Format::Svg,
            CUP,
            None,
            "src",
            &["src/cup.svg".to_owned()],
        )
        .expect_err("taken");
        assert_eq!(taken, "src/cup.svg already exists.");
    }
}
