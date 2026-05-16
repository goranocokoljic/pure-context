<?php

namespace App\Http\Controllers;

use App\Models\User;
use App\Services\UserService;

const APP_VERSION = '1.0.0';

/** The application display name. */
define('APP_NAME', 'MyApp');
define('MAX_UPLOAD_SIZE', 10485760);

interface Countable
{
    const MAX_COUNT = 1000;

    public function count(): int;
}

abstract class BaseController
{
    abstract public function index(): array;

    abstract protected function render(string $view): string;
}

/**
 * Handles user-related HTTP requests.
 */
class UserController extends BaseController implements Countable
{
    public const MAX_RESULTS = 100;

    public string $status = 'active';

    protected int $timeout = 30;

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

/** Formats a user record as a display string. */
$formatUser = function(User $user): string {
    return $user->name . ' <' . $user->email . '>';
};

$calculateAge = fn(int $birthYear): int => date('Y') - $birthYear;

trait Loggable
{
    public function log(string $message): void {}
}

enum Status: string
{
    case Active = 'active';
    case Inactive = 'inactive';
}
