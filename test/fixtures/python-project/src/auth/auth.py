"""Authentication module."""

from __future__ import annotations

import hashlib
import os
from typing import Optional

from .models import User

MAX_LOGIN_ATTEMPTS = 5
SECRET_KEY = "change-me"


def hash_password(password: str, salt: Optional[str] = None) -> str:
    """Hash a password with an optional salt.

    Returns the hex digest of the hash.
    """
    if salt is None:
        salt = os.urandom(16).hex()
    digest = hashlib.sha256(f"{salt}{password}".encode()).hexdigest()
    return f"{salt}:{digest}"


def verify_password(password: str, hashed: str) -> bool:
    """Verify a password against its hash."""
    try:
        salt, _ = hashed.split(":", 1)
        return hash_password(password, salt) == hashed
    except ValueError:
        return False


@staticmethod
def _internal_helper(value: str) -> str:
    return value.strip()


class AuthService:
    """Service for handling user authentication."""

    def __init__(self, secret: str) -> None:
        """Initialise with a signing secret."""
        self._secret = secret
        self._attempts: dict[str, int] = {}

    def login(self, username: str, password: str) -> Optional[str]:
        """Attempt a login and return a session token on success."""
        if self._attempts.get(username, 0) >= MAX_LOGIN_ATTEMPTS:
            return None
        user = self._find_user(username)
        if user and verify_password(password, user.password_hash):
            self._attempts.pop(username, None)
            return self._generate_token(username)
        self._attempts[username] = self._attempts.get(username, 0) + 1
        return None

    def logout(self, token: str) -> None:
        """Invalidate a session token."""
        pass

    @classmethod
    def from_env(cls) -> "AuthService":
        """Create an AuthService from environment variables."""
        return cls(os.environ.get("SECRET_KEY", SECRET_KEY))

    @staticmethod
    def validate_username(username: str) -> bool:
        """Check if a username meets the requirements."""
        return 3 <= len(username) <= 32 and username.isalnum()

    def _find_user(self, username: str) -> Optional[User]:
        return None

    def _generate_token(self, username: str) -> str:
        return hashlib.sha256(f"{username}{self._secret}".encode()).hexdigest()
