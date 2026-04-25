"""Tests for authentication module."""

import pytest
from src.auth.auth import AuthService, AuthError


def test_login_success():
    """Test successful login returns a token."""
    service = AuthService()
    token = service.login("admin", "secret")
    assert token is not None


def test_login_invalid_credentials():
    """Test login with invalid credentials raises AuthError."""
    service = AuthService()
    with pytest.raises(AuthError):
        service.login("admin", "wrong")


def test_logout():
    """Test logout invalidates the session."""
    service = AuthService()
    token = service.login("admin", "secret")
    service.logout(token)
    assert not service.validate_token(token)


class TestTokenValidation:
    """Tests for token validation logic."""

    def test_valid_token(self):
        """Valid token passes validation."""
        service = AuthService()
        token = service.login("admin", "secret")
        assert service.validate_token(token)

    def test_expired_token(self):
        """Expired token fails validation."""
        service = AuthService()
        assert not service.validate_token("expired-token-xyz")
