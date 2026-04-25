using System;

namespace PureContext.Fixture
{
    /// <summary>
    /// Represents a user in the system.
    /// </summary>
    public record User(long Id, string Username, string Email)
    {
        /// <summary>Gets or sets the user's display name.</summary>
        public string DisplayName { get; set; } = Username;

        /// <summary>Gets or sets the user's role.</summary>
        public string Role { get; set; } = "user";

        /// <summary>Check if the user has administrator privileges.</summary>
        public bool IsAdmin()
        {
            return Role == "admin";
        }
    }
}
