/**
 * Fixture: NestJS-style controller with route decorators.
 * Used by search_by_decorator tests (Task 193).
 */

// ─── Stub decorator factories ────────────────────────────────────────────────

export function Controller(path: string): ClassDecorator {
  return () => {};
}

export function Get(path?: string): MethodDecorator {
  return () => {};
}

export function Post(path?: string): MethodDecorator {
  return () => {};
}

export function Put(path?: string): MethodDecorator {
  return () => {};
}

export function Delete(path?: string): MethodDecorator {
  return () => {};
}

export function UseGuards(...guards: unknown[]): MethodDecorator & ClassDecorator {
  return () => {};
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface CreateUserDto {
  name: string;
  email: string;
}

// ─── Controller class ─────────────────────────────────────────────────────────

@Controller('/api/users')
export class UserController {
  @Get('/')
  getUsers(): User[] {
    return [];
  }

  @Post('/')
  createUser(dto: CreateUserDto): Promise<User> {
    return Promise.resolve({ id: '1', ...dto });
  }

  @Get('/:id')
  @UseGuards('AuthGuard')
  getUserById(id: string): Promise<User | null> {
    return Promise.resolve(null);
  }

  @Put('/:id')
  updateUser(id: string, dto: CreateUserDto): Promise<User> {
    return Promise.resolve({ id, ...dto });
  }

  @Delete('/:id')
  deleteUser(id: string): Promise<void> {
    return Promise.resolve();
  }
}

@Controller('/api/admin')
@UseGuards('AdminGuard')
export class AdminController {
  @Get('/stats')
  getStats(): Record<string, number> {
    return { users: 0 };
  }

  @Post('/reset')
  resetDatabase(): Promise<void> {
    return Promise.resolve();
  }
}
