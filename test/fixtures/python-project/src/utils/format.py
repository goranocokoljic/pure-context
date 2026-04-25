"""String and number formatting utilities."""

from typing import Union

DEFAULT_PRECISION = 2
MAX_LENGTH = 255


def truncate(text: str, max_len: int = MAX_LENGTH) -> str:
    """Truncate a string to at most max_len characters."""
    if len(text) <= max_len:
        return text
    return text[: max_len - 3] + "..."


def format_number(value: Union[int, float], precision: int = DEFAULT_PRECISION) -> str:
    """Format a number to a fixed number of decimal places."""
    return f"{value:.{precision}f}"


def slugify(text: str) -> str:
    """Convert text to a URL-safe slug."""
    return text.lower().replace(" ", "-")


def _internal_normalize(s: str) -> str:
    """Internal helper — should not appear as a top-level navigation target."""
    return s.strip().lower()
