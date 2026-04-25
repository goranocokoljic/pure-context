import java.util.HashSet;
import java.util.Set;
import static java.util.Objects.requireNonNull;

/**
 * Service responsible for managing user authentication sessions.
 * Provides methods for login, logout, and session validation.
 */
public class AuthService implements IAuthenticator {

    private static final int MAX_SESSIONS = 1000;

    private final Set<String> activeSessions = new HashSet<>();

    /**
     * Authenticate a user with the provided credentials.
     * Returns true if authentication succeeds.
     */
    public boolean authenticate(String username, String password) {
        requireNonNull(username, "username must not be null");
        return !username.isEmpty() && !password.isEmpty();
    }

    /**
     * Start a new session for the given token.
     */
    public void startSession(String token) {
        if (activeSessions.size() >= MAX_SESSIONS) {
            throw new IllegalStateException("Max sessions reached");
        }
        activeSessions.add(token);
    }

    /**
     * Check if a session token is currently active.
     */
    public boolean isActive(String token) {
        return activeSessions.contains(token);
    }

    /**
     * End a session by removing its token.
     */
    public void endSession(String token) {
        activeSessions.remove(token);
    }

    /** Private helper — should not be indexed. */
    private void cleanup() {
        activeSessions.clear();
    }
}
