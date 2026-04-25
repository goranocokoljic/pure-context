namespace PureContext.Fixture
{
    /// <summary>
    /// Defines the contract for authentication services.
    /// </summary>
    public interface IAuthenticator
    {
        /// <summary>Authenticate with the provided credentials.</summary>
        bool Authenticate(string username, string password);

        /// <summary>Check whether the given session token is active.</summary>
        bool IsActive(string token);
    }
}
