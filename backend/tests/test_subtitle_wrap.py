from services.subtitle_segmenter import apply_translate_line_wrap, wrap_subtitle_text


def test_wrap_vietnamese_max_eight_words():
    text = "Anh mất sự cân bằng và rối trí hoàn toàn"
    wrapped = wrap_subtitle_text(text, max_words=8)
    lines = wrapped.split("\n")
    assert all(len(line.split()) <= 8 for line in lines)
    assert wrapped.replace("\n", " ") == text
    assert lines == ["Anh mất sự cân bằng và rối trí hoàn", "toàn"]


def test_wrap_exactly_eight_words_single_line():
    text = "one two three four five six seven eight"
    assert wrap_subtitle_text(text, max_words=8) == text


def test_wrap_cjk_counts_characters_as_units():
    text = "你好世界欢迎光临今天"
    wrapped = wrap_subtitle_text(text, max_words=8)
    lines = wrapped.split("\n")
    assert all(len(line) <= 8 for line in lines)
    assert "".join(lines) == text
    assert lines == ["你好世界欢迎光临", "今天"]


def test_apply_translate_line_wrap():
    items = [{"id": "s1", "text": " ".join(f"w{i}" for i in range(10))}]
    out = apply_translate_line_wrap(items, max_words=8)
    lines = out[0]["text"].split("\n")
    assert len(lines) == 2
    assert len(lines[0].split()) == 8
    assert len(lines[1].split()) == 2
