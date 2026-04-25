<?php

namespace App\Models;

/**
 * Plain PHP user model (no ORM).
 */
class User
{
    public int $id;
    public string $name;
    public string $email;

    public function __construct(int $id, string $name, string $email)
    {
        $this->id    = $id;
        $this->name  = $name;
        $this->email = $email;
    }

    /**
     * Returns a display name combining name and email.
     */
    public function displayName(): string
    {
        return "{$this->name} <{$this->email}>";
    }

    /**
     * Creates a guest user.
     */
    public static function guest(): self
    {
        return new self(0, 'Guest', 'guest@example.com');
    }

    private function validate(): bool
    {
        return str_contains($this->email, '@');
    }
}
