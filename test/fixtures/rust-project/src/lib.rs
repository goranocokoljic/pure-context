use std::collections::HashMap;
use std::fmt;
extern crate serde;

/// Represents a user in the system.
pub struct User {
    pub name: String,
    pub age: u32,
    email: String,
}

/// Role assigned to a user.
pub enum Role {
    Admin,
    Editor,
    Viewer,
}

/// Validator trait for types that can be validated.
pub trait Validator {
    fn validate(&self) -> bool;
}

/// Type alias for a map of string keys to string values.
pub type Config = HashMap<String, String>;

/// Maximum number of retries allowed.
pub const MAX_RETRIES: u32 = 3;

/// Private function — should not be indexed.
fn private_helper() -> String {
    String::from("private")
}

/// Authenticate a user with the given credentials.
pub fn authenticate(username: &str, password: &str) -> bool {
    !username.is_empty() && !password.is_empty()
}

impl User {
    /// Create a new User instance.
    pub fn new(name: String, age: u32, email: String) -> Self {
        User { name, age, email }
    }

    /// Get the user's email address.
    pub fn email(&self) -> &str {
        &self.email
    }

    fn private_method(&self) {
        // private — NOT indexed (pub required for impl methods)
    }
}

impl Validator for User {
    fn validate(&self) -> bool {
        !self.name.is_empty() && self.age > 0
    }
}

impl fmt::Display for User {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.name, self.age)
    }
}
