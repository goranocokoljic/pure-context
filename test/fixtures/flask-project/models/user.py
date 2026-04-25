"""Plain Python class — not a Django/SQLAlchemy model.

This file exists to verify that the Flask adapter does not
extract plain classes as route or model symbols.
"""


class User:
    """Represents an application user (plain dataclass-style)."""

    def __init__(self, user_id: int, name: str, email: str) -> None:
        self.user_id = user_id
        self.name = name
        self.email = email

    def display_name(self) -> str:
        return f"{self.name} <{self.email}>"

    @classmethod
    def guest(cls) -> "User":
        return cls(0, "Guest", "guest@example.com")

    def __repr__(self) -> str:
        return f"User(id={self.user_id!r}, name={self.name!r})"
