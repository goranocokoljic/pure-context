/**
 * Represents a user in the system.
 * Stores identity and role information.
 */
public class User {

    private final long id;
    private String username;
    private String email;
    private Role role;

    /**
     * Construct a new User with required fields.
     */
    public User(long id, String username, String email) {
        this.id = id;
        this.username = username;
        this.email = email;
        this.role = Role.USER;
    }

    /** Get the user's unique identifier. */
    public long getId() {
        return id;
    }

    /** Get the username. */
    public String getUsername() {
        return username;
    }

    /** Get the email address. */
    public String getEmail() {
        return email;
    }

    /** Get the user's role. */
    public Role getRole() {
        return role;
    }

    /** Set the user's role. */
    public void setRole(Role role) {
        this.role = role;
    }

    /** Private helper — should not be indexed. */
    private boolean isValid() {
        return username != null && !username.isEmpty();
    }
}
