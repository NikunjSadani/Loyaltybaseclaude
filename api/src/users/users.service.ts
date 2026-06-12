import {
  Injectable, NotFoundException, ConflictException,
  ForbiddenException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { User, UserRole, UserStatus } from '@prisma/client';

interface CreateUserDto {
  clientId: string;
  name:     string;
  phone:    string;
  role:     string;
  email?:   string;
}

interface UpdateUserDto {
  name?:   string;
  email?:  string;
  status?: UserStatus;
  fcmToken?: string;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createUser(dto: CreateUserDto): Promise<User> {
    // Check duplicate phone within same client
    const existing = await this.prisma.user.findFirst({
      where: { phone: dto.phone, clientId: dto.clientId, deletedAt: null },
    });
    if (existing) {
      throw new ConflictException(`Phone ${dto.phone} is already registered for this client.`);
    }

    return this.prisma.user.create({
      data: {
        clientId: dto.clientId,
        name:     dto.name,
        phone:    dto.phone,
        role:     dto.role as UserRole,
        email:    dto.email,
        status:   'PENDING',
      },
    });
  }

  async findById(id: string, clientId: string): Promise<User> {
    const user = await this.prisma.user.findFirst({
      where: { id, clientId, deletedAt: null },
    });
    if (!user) throw new NotFoundException(`User not found.`);
    return user;
  }

  async findByPhone(phone: string, clientId: string): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: { phone, clientId, deletedAt: null },
    });
  }

  async listUsers(
    clientId: string,
    opts: { role?: string; status?: string; page?: number; limit?: number } = {},
  ): Promise<{ data: User[]; total: number; page: number }> {
    const page  = opts.page  ?? 1;
    const limit = opts.limit ?? 20;
    const skip  = (page - 1) * limit;

    const where: any = { clientId, deletedAt: null };
    if (opts.role)   where.role   = opts.role;
    if (opts.status) where.status = opts.status;

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({ where, skip, take: limit, orderBy: { createdAt: 'desc' } }),
      this.prisma.user.count({ where }),
    ]);

    return { data, total, page };
  }

  async updateUser(id: string, clientId: string, dto: UpdateUserDto & { clientId?: string }): Promise<User> {
    // Prevent tenant escape
    if ('clientId' in dto) {
      throw new ForbiddenException('Cannot change clientId — this would move the user to another tenant.');
    }

    await this.findById(id, clientId); // throws if not found or wrong tenant

    return this.prisma.user.update({
      where: { id },
      data:  { ...dto, updatedAt: new Date() },
    });
  }

  async softDeleteUser(id: string, clientId: string): Promise<void> {
    await this.findById(id, clientId);
    await this.prisma.user.update({
      where: { id },
      data:  { deletedAt: new Date(), status: 'INACTIVE' },
    });
    this.logger.log(`User ${id} soft-deleted (client: ${clientId})`);
  }

  async activateUser(id: string, clientId: string): Promise<User> {
    await this.findById(id, clientId);
    return this.prisma.user.update({
      where: { id },
      data:  { status: 'ACTIVE' },
    });
  }
}
