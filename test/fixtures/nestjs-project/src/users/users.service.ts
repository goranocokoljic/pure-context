import { Injectable } from '@nestjs/common';

@Injectable()
export class UsersService {
  private users: any[] = [];

  findAll() {
    return this.users;
  }

  findOne(id: number) {
    return this.users.find(u => u.id === id);
  }

  create(dto: any) {
    this.users.push(dto);
    return dto;
  }

  update(id: number, dto: any) {
    const idx = this.users.findIndex(u => u.id === id);
    if (idx >= 0) this.users[idx] = { ...this.users[idx], ...dto };
    return this.users[idx];
  }

  remove(id: number) {
    this.users = this.users.filter(u => u.id !== id);
  }
}
