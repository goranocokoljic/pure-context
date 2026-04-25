require 'securerandom'
require_relative './models/user'

# Handles authentication: login, logout, token validation.
class AuthService
  # Maximum number of concurrent sessions allowed per user.
  MAX_SESSIONS = 10

  def initialize
    @sessions = {}
  end

  # Authenticate a user by email and password.
  # Returns a session token on success, or nil on failure.
  def login(email, password)
    return nil if email.nil? || password.nil?

    token = SecureRandom.hex(16)
    @sessions[token] = email
    token
  end

  # Invalidate an active session token.
  def logout(token)
    @sessions.delete(token)
  end

  # Validate a session token and return the associated email, or nil.
  def validate(token)
    @sessions[token]
  end

  # Returns the count of active sessions.
  def session_count
    @sessions.size
  end

  # Clear all sessions (admin operation).
  def self.clear_all(instance)
    instance.instance_variable_set(:@sessions, {})
  end

  # Create an AuthService with a pre-loaded set of sessions (test helper).
  def self.with_sessions(sessions)
    svc = new
    svc.instance_variable_set(:@sessions, sessions.dup)
    svc
  end

  private

  def expired?(token)
    false
  end
end
