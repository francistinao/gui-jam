//! Converts oxc's UTF-8 byte offsets to and from `data-gj-src` positions: 1-based
//! lines split on `\n` and 1-based columns counted in UTF-16 code units, the
//! convention the Vite plugin writes (docs/adr/0007).

pub struct LineIndex<'s> {
    source: &'s str,
    line_starts: Vec<usize>,
}

impl<'s> LineIndex<'s> {
    #[must_use]
    pub fn new(source: &'s str) -> Self {
        let line_starts = std::iter::once(0)
            .chain(source.match_indices('\n').map(|(index, _)| index + 1))
            .collect();
        Self {
            source,
            line_starts,
        }
    }

    /// Byte offset of a position, or `None` when the position is past the end of
    /// its line or points into the middle of a character.
    #[must_use]
    pub fn offset(&self, line: u64, column: u64) -> Option<usize> {
        let line_index = usize::try_from(line).ok()?.checked_sub(1)?;
        let start = *self.line_starts.get(line_index)?;
        let end = self
            .line_starts
            .get(line_index + 1)
            .map_or(self.source.len(), |next| next - 1);
        let wanted = usize::try_from(column).ok()?.checked_sub(1)?;
        let mut units = 0;
        for (index, ch) in self.source[start..end].char_indices() {
            if units == wanted {
                return Some(start + index);
            }
            units += ch.len_utf16();
            if units > wanted {
                return None;
            }
        }
        (units == wanted).then_some(end)
    }

    /// `(line, column)` of a byte offset that lies on a character boundary.
    #[must_use]
    pub fn position(&self, offset: usize) -> (u64, u64) {
        let line = self.line_starts.partition_point(|&start| start <= offset);
        let start = self.line_starts[line - 1];
        let column = self.source[start..offset].encode_utf16().count() + 1;
        (to_u64(line), to_u64(column))
    }
}

fn to_u64(value: usize) -> u64 {
    u64::try_from(value).expect("usize fits in u64 on supported targets")
}

#[cfg(test)]
mod tests {
    use super::LineIndex;

    #[test]
    fn maps_ascii_positions_both_ways() {
        let index = LineIndex::new("ab\ncde\n");

        assert_eq!(index.offset(1, 1), Some(0));
        assert_eq!(index.offset(2, 3), Some(5));
        assert_eq!(index.position(5), (2, 3));
    }

    #[test]
    fn counts_korean_as_one_utf16_unit_per_syllable() {
        let source = "<p>오늘 <span>";
        let span = source.find("<span").expect("span present");
        let index = LineIndex::new(source);

        assert_eq!(index.position(span), (1, 7));
        assert_eq!(index.offset(1, 7), Some(span));
    }

    #[test]
    fn counts_emoji_as_two_utf16_units_and_rejects_the_middle() {
        let source = "😀<b>";
        let index = LineIndex::new(source);

        assert_eq!(index.offset(1, 3), Some(4));
        assert_eq!(index.offset(1, 2), None);
    }

    #[test]
    fn keeps_carriage_returns_on_the_previous_line() {
        let index = LineIndex::new("a\r\n<b>");

        assert_eq!(index.offset(2, 1), Some(3));
        assert_eq!(index.position(3), (2, 1));
    }

    #[test]
    fn rejects_positions_outside_the_source() {
        let index = LineIndex::new("ab");

        assert_eq!(index.offset(0, 1), None);
        assert_eq!(index.offset(1, 0), None);
        assert_eq!(index.offset(1, 4), None);
        assert_eq!(index.offset(2, 1), None);
        assert_eq!(index.offset(1, 3), Some(2));
    }
}
