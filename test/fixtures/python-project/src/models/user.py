"""User model definitions."""

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class User:
    """Represents an application user."""

    id: str
    username: str
    email: str
    password_hash: str = ""
    is_active: bool = True
    roles: list = field(default_factory=list)

    def display_name(self) -> str:
        """Return the user's display name."""
        return self.username

    def has_role(self, role: str) -> bool:
        """Check if the user has a specific role."""
        return role in self.roles

    def deactivate(self) -> None:
        """Deactivate this user account."""
        self.is_active = False


@dataclass
class AnonymousUser:
    """Represents an unauthenticated visitor."""

    is_active: bool = False

    def display_name(self) -> str:
        """Return the anonymous display name."""
        return "Anonymous"
