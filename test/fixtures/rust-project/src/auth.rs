use std::collections::HashSet;

/// Service responsible for authentication logic.
pub struct AuthService {
    sessions: HashSet<String>,
}

impl AuthService {
    /// Create a new AuthService with no active sessions.
    pub fn new() -> Self {
        AuthService {
            sessions: HashSet::new(),
        }
    }

    /// Start a new authenticated session for the given token.
    pub fn start_session(&mut self, token: String) {
        self.sessions.insert(token);
    }

    /// Check if the token is part of an active session.
    pub fn is_active(&self, token: &str) -> bool {
        self.sessions.contains(token)
    }

    /// End a session, removing the token.
    pub fn end_session(&mut self, token: &str) {
        self.sessions.remove(token);
    }
}
