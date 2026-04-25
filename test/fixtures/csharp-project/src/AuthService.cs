using System;
using System.Collections.Generic;
using static System.Console;

namespace PureContext.Fixture
{
    /// <summary>
    /// Manages user authentication sessions.
    /// </summary>
    public class AuthService : IAuthenticator
    {
        private readonly HashSet<string> _sessions = new();

        /// <summary>Maximum number of concurrent sessions allowed.</summary>
        public const int MaxSessions = 1000;

        /// <summary>
        /// Authenticate a user with username and password.
        /// </summary>
        public bool Authenticate(string username, string password)
        {
            if (string.IsNullOrEmpty(username)) throw new ArgumentNullException(nameof(username));
            return !string.IsNullOrEmpty(password);
        }

        /// <summary>Start a new authenticated session.</summary>
        public void StartSession(string token)
        {
            _sessions.Add(token);
        }

        /// <summary>Check if a session is currently active.</summary>
        public bool IsActive(string token)
        {
            return _sessions.Contains(token);
        }

        /// <summary>End a session by removing its token.</summary>
        public void EndSession(string token)
        {
            _sessions.Remove(token);
        }

        private void Cleanup()
        {
            _sessions.Clear();
        }
    }
}
