const FEATURE_CONTAINERS: [&str; 8] = [
    "features", "modules", "domains", "pages", "routes", "views", "screens", "app",
];
const SHARED_DIRS: [&str; 10] = [
    "components",
    "shared",
    "common",
    "ui",
    "design-system",
    "lib",
    "atoms",
    "molecules",
    "organisms",
    "elements",
];
const ROUTE_ENTRIES: [&str; 10] = [
    "page",
    "layout",
    "loading",
    "error",
    "not-found",
    "template",
    "default",
    "route",
    "+page",
    "+layout",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Scope {
    SameFeature,
    Shared,
    Global,
    OtherFeature,
}

impl Scope {
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::SameFeature => "same feature",
            Self::Shared => "shared",
            Self::Global => "global",
            Self::OtherFeature => "other feature",
        }
    }

    #[must_use]
    pub fn bonus(self) -> f64 {
        match self {
            Self::SameFeature => 0.15,
            Self::Shared => 0.1,
            Self::Global => 0.05,
            Self::OtherFeature => 0.0,
        }
    }
}

fn directories(path: &str) -> Vec<&str> {
    let mut segments: Vec<&str> = path.split('/').collect();
    segments.pop();
    segments
}

#[must_use]
pub fn feature_root(path: &str) -> Option<String> {
    let segments = directories(path);
    let at = segments
        .iter()
        .position(|segment| FEATURE_CONTAINERS.contains(segment))?;
    let feature = segments.get(at + 1)?;
    if SHARED_DIRS.contains(feature) {
        return None;
    }
    Some(segments[..=at + 1].join("/"))
}

#[must_use]
pub fn in_shared_folder(path: &str) -> bool {
    directories(path)
        .iter()
        .any(|segment| SHARED_DIRS.contains(segment))
}

#[must_use]
pub fn is_route_entry(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    let stem = name.split_once('.').map_or(name, |(stem, _)| stem);
    ROUTE_ENTRIES.contains(&stem)
}

#[must_use]
pub fn scope_of(component: &str, global: bool, selected: &str) -> Scope {
    if global {
        return Scope::Global;
    }
    match (feature_root(component), feature_root(selected)) {
        (Some(own), Some(other)) if own == other => Scope::SameFeature,
        (None, _) if in_shared_folder(component) => Scope::Shared,
        _ => Scope::OtherFeature,
    }
}

#[cfg(test)]
mod tests {
    use super::{Scope, feature_root, is_route_entry, scope_of};

    #[test]
    fn finds_the_feature_a_file_belongs_to() {
        let cases = [
            (
                "src/features/rewards/RewardsSignup.tsx",
                Some("src/features/rewards"),
            ),
            (
                "src/features/rewards/components/RewardsHint.tsx",
                Some("src/features/rewards"),
            ),
            (
                "src/modules/billing/ui/Invoice.tsx",
                Some("src/modules/billing"),
            ),
            ("app/(shop)/cart/_components/Line.tsx", Some("app/(shop)")),
            ("src/pages/checkout/Summary.vue", Some("src/pages/checkout")),
            ("app/components/ui/button.tsx", None),
            ("src/components/ErrorMessage.tsx", None),
            ("src/features/Index.tsx", None),
            ("src/App.tsx", None),
        ];
        for (path, root) in cases {
            assert_eq!(feature_root(path).as_deref(), root, "{path}");
        }
    }

    #[test]
    fn ranks_the_same_feature_then_shared_then_global_then_other_features() {
        let selected = "src/features/rewards/RewardsSignup.tsx";
        let cases = [
            (
                "src/features/rewards/RewardsHint.tsx",
                false,
                Scope::SameFeature,
            ),
            ("src/components/ErrorMessage.tsx", false, Scope::Shared),
            ("src/components/ui/alert.tsx", false, Scope::Shared),
            ("src/components/atoms/Badge.tsx", false, Scope::Shared),
            ("src/shared/forms/FieldError.tsx", false, Scope::Shared),
            ("packages/ui/src/Alert.tsx", true, Scope::Global),
            (
                "src/features/billing/BillingError.tsx",
                false,
                Scope::OtherFeature,
            ),
            ("src/App.tsx", false, Scope::OtherFeature),
        ];
        for (component, global, scope) in cases {
            assert_eq!(scope_of(component, global, selected), scope, "{component}");
        }
        assert!(Scope::SameFeature < Scope::Shared);
        assert!(Scope::Shared < Scope::Global);
        assert!(Scope::Global < Scope::OtherFeature);
    }

    #[test]
    fn tells_route_entry_files_from_components() {
        for path in [
            "app/(shop)/cart/page.tsx",
            "app/layout.tsx",
            "app/error.tsx",
            "src/routes/+page.svelte",
            "app/routes/route.tsx",
        ] {
            assert!(is_route_entry(path), "{path}");
        }
        for path in ["src/components/ErrorMessage.tsx", "src/pages/Checkout.tsx"] {
            assert!(!is_route_entry(path), "{path}");
        }
    }
}
