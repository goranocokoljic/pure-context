/**
 * Fixture: TypeORM-style entity with property decorators.
 * Used by search_by_decorator tests (Task 193).
 */

// ─── Stub decorators ──────────────────────────────────────────────────────────

export function Entity(tableName?: string): ClassDecorator {
  return () => {};
}

export function PrimaryGeneratedColumn(): PropertyDecorator {
  return () => {};
}

export function Column(options?: Record<string, unknown>): PropertyDecorator {
  return () => {};
}

export function CreateDateColumn(): PropertyDecorator {
  return () => {};
}

export function UpdateDateColumn(): PropertyDecorator {
  return () => {};
}

export function BeforeInsert(): MethodDecorator {
  return () => {};
}

export function AfterInsert(): MethodDecorator {
  return () => {};
}

// ─── Entity classes ───────────────────────────────────────────────────────────

@Entity('users')
export class UserEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ nullable: false })
  name!: string;

  @Column({ type: 'varchar', length: 255 })
  email!: string;

  @Column({ nullable: true })
  bio?: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @BeforeInsert()
  normalizeEmail(): void {
    this.email = this.email.toLowerCase();
  }

  @AfterInsert()
  sendWelcomeEmail(): void {
    // noop
  }
}

@Entity('posts')
export class PostEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @Column({ type: 'text' })
  body!: string;

  @Column({ default: false })
  published!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @BeforeInsert()
  validateTitle(): void {
    if (!this.title) throw new Error('Title required');
  }
}
