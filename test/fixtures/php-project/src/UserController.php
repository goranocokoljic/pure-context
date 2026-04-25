<?php

namespace App\Http\Controllers;

use App\Models\User;
use App\Services\UserService;

const APP_VERSION = '1.0.0';

/**
 * Handles user-related HTTP requests.
 */
class UserController extends BaseController implements Countable
{
    public const MAX_RESULTS = 100;

    private UserService $service;

    public function __construct(UserService $service)
    {
        $this->service = $service;
    }

    /**
     * List all users.
     */
    public function index(): array
    {
        return $this->service->getAll();
    }

    /**
     * Show a single user.
     */
    public function show(int $id): User
    {
        return $this->service->find($id);
    }

    protected function validate(array $data): bool
    {
        return !empty($data);
    }

    private function secret(): void
    {
        // private - should NOT be indexed
    }
}

/**
 * Returns a greeting string.
 */
function greet(string $name): string
{
    return "Hello, $name!";
}

interface Countable
{
    public function count(): int;
}

trait Loggable
{
    public function log(string $message): void {}
}

enum Status
{
    case Active;
    case Inactive;
}
