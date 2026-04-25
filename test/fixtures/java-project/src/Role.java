/**
 * Enumeration of user role levels.
 */
public enum Role {
    ADMIN,
    EDITOR,
    USER,
    GUEST;

    /** Check if this role has administrative privileges. */
    public boolean isAdmin() {
        return this == ADMIN;
    }
}
