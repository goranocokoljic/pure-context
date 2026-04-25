<?php

namespace App\Services;

use App\Models\User;

/**
 * Contract for authentication services.
 */
interface AuthServiceInterface
{
    public function login(string $email, string $password): ?string;
    public function logout(string $token): void;
    public function validate(string $token): ?User;
}

/**
 * Default implementation of the authentication service.
 */
class AuthService implements AuthServiceInterface
{
    private array $sessions = [];

    /**
     * Authenticate a user by email and password.
     * Returns a session token on success, or null on failure.
     */
    public function login(string $email, string $password): ?string
    {
        // Simplified: accept any non-empty credentials
        if (empty($email) || empty($password)) {
            return null;
        }
        $token = bin2hex(random_bytes(16));
        $this->sessions[$token] = $email;
        return $token;
    }

    /**
     * Invalidate a session token.
     */
    public function logout(string $token): void
    {
        unset($this->sessions[$token]);
    }

    /**
     * Return the User associated with a token, or null if invalid.
     */
    public function validate(string $token): ?User
    {
        $email = $this->sessions[$token] ?? null;
        if ($email === null) {
            return null;
        }
        return new User(1, 'Auth User', $email);
    }

    private function hashPassword(string $password): string
    {
        return password_hash($password, PASSWORD_BCRYPT);
    }
}
