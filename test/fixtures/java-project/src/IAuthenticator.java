/**
 * Interface defining the contract for authentication services.
 */
public interface IAuthenticator {

    /**
     * Authenticate a user with the provided credentials.
     */
    public boolean authenticate(String username, String password);

    /**
     * Check whether a session is currently active.
     */
    public boolean isActive(String token);
}
