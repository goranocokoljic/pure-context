/// Represents a user record in the database.
pub struct User {
    pub id: u64,
    pub username: String,
    pub email: String,
}

/// Role levels for access control.
pub enum Role {
    SuperAdmin,
    Admin,
    User,
    Guest,
}

/// Private struct — should not be indexed.
struct Internal {
    secret: String,
}
