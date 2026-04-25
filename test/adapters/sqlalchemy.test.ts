import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { sqlalchemyAdapter } from '../../src/adapters/sqlalchemy.js';
import { _resetForTesting } from '../../src/adapters/adapter-registry.js';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/sqlalchemy-project');

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-sqlalchemy-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  _resetForTesting();
});

// ─── Adapter metadata ─────────────────────────────────────────────────────────

describe('sqlalchemyAdapter metadata', () => {
  it('has name "sqlalchemy"', () => {
    expect(sqlalchemyAdapter.name).toBe('sqlalchemy');
  });

  it('declares no extra extensions', () => {
    expect(sqlalchemyAdapter.extensions()).toEqual([]);
  });
});

// ─── Detection ────────────────────────────────────────────────────────────────

describe('sqlalchemyAdapter.detect', () => {
  it('detects via requirements.txt with SQLAlchemy', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'requirements.txt'), 'SQLAlchemy>=2.0\nflask>=3.0\n');
    expect(await sqlalchemyAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects via requirements.txt with lowercase sqlalchemy', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'requirements.txt'), 'sqlalchemy==1.4.0\n');
    expect(await sqlalchemyAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects via pyproject.toml', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'pyproject.toml'),
      '[tool.poetry.dependencies]\nsqlalchemy = "^2.0"\n',
    );
    expect(await sqlalchemyAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects via setup.py', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'setup.py'), "install_requires=['SQLAlchemy>=1.4']\n");
    expect(await sqlalchemyAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('returns false when sqlalchemy is absent', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'requirements.txt'), 'flask>=3.0\nrequests>=2.0\n');
    expect(await sqlalchemyAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('returns false without any project files', async () => {
    const dir = tmpDir();
    expect(await sqlalchemyAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('detects fixture sqlalchemy project', async () => {
    expect(await sqlalchemyAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });
});

// ─── File filter ──────────────────────────────────────────────────────────────

describe('sqlalchemyAdapter.fileFilter', () => {
  it('accepts .py files', () => {
    expect(sqlalchemyAdapter.fileFilter('models.py')).toBe(true);
    expect(sqlalchemyAdapter.fileFilter('app/models/user.py')).toBe(true);
  });

  it('rejects non-Python files', () => {
    expect(sqlalchemyAdapter.fileFilter('requirements.txt')).toBe(false);
    expect(sqlalchemyAdapter.fileFilter('models.ts')).toBe(false);
    expect(sqlalchemyAdapter.fileFilter('schema.rb')).toBe(false);
    expect(sqlalchemyAdapter.fileFilter('README.md')).toBe(false);
  });
});

// ─── Model class extraction ───────────────────────────────────────────────────

describe('sqlalchemyAdapter — model class', () => {
  it('emits class symbol with sqlalchemy_model for Base subclass', () => {
    const source = `
from sqlalchemy.orm import declarative_base
from sqlalchemy import Column, Integer

Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    const model = symbols.find((s) => s.name === 'User');
    expect(model).toBeDefined();
    expect(model!.kind).toBe('class');
    expect(model!.frameworkMeta?.sqlalchemy_model).toBe(true);
  });

  it('emits class symbol for DeclarativeBase subclass (SA 2.0)', () => {
    const source = `
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

class Base(DeclarativeBase):
    pass

class Product(Base):
    __tablename__ = "products"
    id: Mapped[int] = mapped_column(primary_key=True)
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    const model = symbols.find((s) => s.name === 'Product');
    expect(model).toBeDefined();
    expect(model!.frameworkMeta?.sqlalchemy_model).toBe(true);
  });

  it('emits class symbol for db.Model (Flask-SQLAlchemy)', () => {
    const source = `
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()

class Post(db.Model):
    __tablename__ = "posts"
    id = db.Column(db.Integer, primary_key=True)
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    const model = symbols.find((s) => s.name === 'Post');
    expect(model).toBeDefined();
    expect(model!.frameworkMeta?.sqlalchemy_model).toBe(true);
  });

  it('does not emit symbol for plain Python class without SA base', () => {
    const source = `
from sqlalchemy import Column, Integer

class Helper:
    id = Column(Integer, primary_key=True)
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'helpers.py');
    expect(symbols.filter((s) => s.frameworkMeta?.sqlalchemy_model)).toHaveLength(0);
  });

  it('does not emit symbols when no sqlalchemy import present', () => {
    const source = `
class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    expect(symbols).toHaveLength(0);
  });
});

// ─── __tablename__ ────────────────────────────────────────────────────────────

describe('sqlalchemyAdapter — __tablename__', () => {
  it('captures explicit __tablename__', () => {
    const source = `
from sqlalchemy.orm import declarative_base
from sqlalchemy import Column, Integer

Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    const model = symbols.find((s) => s.name === 'User');
    expect(model?.frameworkMeta?.table_name).toBe('users');
  });

  it('defaults to lowercase class name when __tablename__ absent', () => {
    const source = `
from sqlalchemy.orm import declarative_base
from sqlalchemy import Column, Integer

Base = declarative_base()

class Product(Base):
    id = Column(Integer, primary_key=True)
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    const model = symbols.find((s) => s.name === 'Product');
    expect(model?.frameworkMeta?.table_name).toBe('product');
  });

  it('uses single-quoted __tablename__', () => {
    const source = `
from sqlalchemy.orm import declarative_base
from sqlalchemy import Column, Integer

Base = declarative_base()

class Order(Base):
    __tablename__ = 'orders'
    id = Column(Integer, primary_key=True)
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    const model = symbols.find((s) => s.name === 'Order');
    expect(model?.frameworkMeta?.table_name).toBe('orders');
  });
});

// ─── Column extraction (SA 1.x) ──────────────────────────────────────────────

describe('sqlalchemyAdapter — Column() 1.x style', () => {
  it('extracts Column(Integer) as INTEGER', () => {
    const source = `
from sqlalchemy.orm import declarative_base
from sqlalchemy import Column, Integer

Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    const col = symbols.find((s) => s.name === 'User.id');
    expect(col).toBeDefined();
    expect(col!.kind).toBe('const');
    expect(col!.frameworkMeta?.column_type).toBe('INTEGER');
  });

  it('extracts Column(String) as VARCHAR', () => {
    const source = `
from sqlalchemy.orm import declarative_base
from sqlalchemy import Column, Integer, String

Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    name = Column(String(100))
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    const col = symbols.find((s) => s.name === 'User.name');
    expect(col?.frameworkMeta?.column_type).toBe('VARCHAR');
  });

  it('extracts Column(Boolean) as BOOLEAN', () => {
    const source = `
from sqlalchemy.orm import declarative_base
from sqlalchemy import Column, Integer, Boolean

Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    is_active = Column(Boolean)
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    const col = symbols.find((s) => s.name === 'User.is_active');
    expect(col?.frameworkMeta?.column_type).toBe('BOOLEAN');
  });

  it('marks primary_key=True', () => {
    const source = `
from sqlalchemy.orm import declarative_base
from sqlalchemy import Column, Integer

Base = declarative_base()

class Product(Base):
    __tablename__ = "products"
    id = Column(Integer, primary_key=True)
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    const pk = symbols.find((s) => s.name === 'Product.id');
    expect(pk?.frameworkMeta?.primary_key).toBe(true);
  });

  it('does not set primary_key for non-PK columns', () => {
    const source = `
from sqlalchemy.orm import declarative_base
from sqlalchemy import Column, Integer, String

Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    name = Column(String)
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    const col = symbols.find((s) => s.name === 'User.name');
    expect(col?.frameworkMeta?.primary_key).toBeUndefined();
  });

  it('captures nullable=False', () => {
    const source = `
from sqlalchemy.orm import declarative_base
from sqlalchemy import Column, Integer, String

Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    email = Column(String, nullable=False)
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    const col = symbols.find((s) => s.name === 'User.email');
    expect(col?.frameworkMeta?.nullable).toBe(false);
  });

  it('captures nullable=True', () => {
    const source = `
from sqlalchemy.orm import declarative_base
from sqlalchemy import Column, Integer, Text

Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    bio = Column(Text, nullable=True)
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    const col = symbols.find((s) => s.name === 'User.bio');
    expect(col?.frameworkMeta?.nullable).toBe(true);
  });

  it('handles Column with ForeignKey (no explicit type)', () => {
    const source = `
from sqlalchemy.orm import declarative_base
from sqlalchemy import Column, Integer, ForeignKey

Base = declarative_base()

class Order(Base):
    __tablename__ = "orders"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"))
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    const col = symbols.find((s) => s.name === 'Order.user_id');
    expect(col).toBeDefined();
    // Integer is still the type even with ForeignKey
    expect(col!.frameworkMeta?.column_type).toBe('INTEGER');
  });

  it('handles multi-line Column definition', () => {
    const source = `
from sqlalchemy.orm import declarative_base
from sqlalchemy import Column, Integer, String

Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    email = Column(
        String(200),
        nullable=False,
    )
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    const col = symbols.find((s) => s.name === 'User.email');
    expect(col).toBeDefined();
    expect(col!.frameworkMeta?.column_type).toBe('VARCHAR');
    expect(col!.frameworkMeta?.nullable).toBe(false);
  });

  it('extracts multiple column types', () => {
    const source = `
from sqlalchemy.orm import declarative_base
from sqlalchemy import Column, Integer, String, Float, Text, Boolean, Numeric, BigInteger

Base = declarative_base()

class Types(Base):
    __tablename__ = "types"
    id = Column(Integer, primary_key=True)
    name = Column(String)
    score = Column(Float)
    notes = Column(Text)
    active = Column(Boolean)
    price = Column(Numeric)
    big_id = Column(BigInteger)
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    const get = (n: string) => symbols.find((s) => s.name === `Types.${n}`);
    expect(get('name')?.frameworkMeta?.column_type).toBe('VARCHAR');
    expect(get('score')?.frameworkMeta?.column_type).toBe('FLOAT');
    expect(get('notes')?.frameworkMeta?.column_type).toBe('TEXT');
    expect(get('active')?.frameworkMeta?.column_type).toBe('BOOLEAN');
    expect(get('price')?.frameworkMeta?.column_type).toBe('DECIMAL');
    expect(get('big_id')?.frameworkMeta?.column_type).toBe('BIGINT');
  });
});

// ─── relationship() extraction ────────────────────────────────────────────────

describe('sqlalchemyAdapter — relationship()', () => {
  it('extracts relationship with target model', () => {
    const source = `
from sqlalchemy.orm import declarative_base, relationship
from sqlalchemy import Column, Integer

Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    orders = relationship("Order")
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    const rel = symbols.find((s) => s.name === 'User.orders');
    expect(rel).toBeDefined();
    expect(rel!.kind).toBe('const');
    expect(rel!.frameworkMeta?.relationship).toBe('Order');
  });

  it('captures back_populates', () => {
    const source = `
from sqlalchemy.orm import declarative_base, relationship
from sqlalchemy import Column, Integer

Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    orders = relationship("Order", back_populates="user")
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    const rel = symbols.find((s) => s.name === 'User.orders');
    expect(rel?.frameworkMeta?.back_populates).toBe('user');
  });

  it('captures relationship without back_populates', () => {
    const source = `
from sqlalchemy.orm import declarative_base, relationship
from sqlalchemy import Column, Integer

Base = declarative_base()

class Order(Base):
    __tablename__ = "orders"
    id = Column(Integer, primary_key=True)
    items = relationship("OrderItem")
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    const rel = symbols.find((s) => s.name === 'Order.items');
    expect(rel?.frameworkMeta?.back_populates).toBeUndefined();
  });

  it('handles multi-line relationship definition', () => {
    const source = `
from sqlalchemy.orm import declarative_base, relationship
from sqlalchemy import Column, Integer

Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    orders = relationship(
        "Order",
        back_populates="user",
        lazy="select",
    )
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    const rel = symbols.find((s) => s.name === 'User.orders');
    expect(rel).toBeDefined();
    expect(rel!.frameworkMeta?.relationship).toBe('Order');
    expect(rel!.frameworkMeta?.back_populates).toBe('user');
  });
});

// ─── SQLAlchemy 2.0 mapped_column ─────────────────────────────────────────────

describe('sqlalchemyAdapter — SA 2.0 mapped_column', () => {
  it('extracts mapped_column with Mapped[int]', () => {
    const source = `
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

class Base(DeclarativeBase):
    pass

class Product(Base):
    __tablename__ = "products"
    id: Mapped[int] = mapped_column(primary_key=True)
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    const col = symbols.find((s) => s.name === 'Product.id');
    expect(col).toBeDefined();
    expect(col!.kind).toBe('const');
    expect(col!.frameworkMeta?.column_type).toBe('INTEGER');
    expect(col!.frameworkMeta?.primary_key).toBe(true);
  });

  it('extracts mapped_column with Mapped[str]', () => {
    const source = `
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

class Base(DeclarativeBase):
    pass

class Product(Base):
    __tablename__ = "products"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(nullable=False)
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    const col = symbols.find((s) => s.name === 'Product.name');
    expect(col?.frameworkMeta?.column_type).toBe('VARCHAR');
    expect(col?.frameworkMeta?.nullable).toBe(false);
  });

  it('extracts mapped_column with explicit SA type', () => {
    const source = `
from sqlalchemy import String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

class Base(DeclarativeBase):
    pass

class Product(Base):
    __tablename__ = "products"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    const col = symbols.find((s) => s.name === 'Product.name');
    expect(col?.frameworkMeta?.column_type).toBe('VARCHAR');
  });

  it('handles Optional[str] in Mapped annotation', () => {
    const source = `
from typing import Optional
from sqlalchemy import Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

class Base(DeclarativeBase):
    pass

class Product(Base):
    __tablename__ = "products"
    id: Mapped[int] = mapped_column(primary_key=True)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    const col = symbols.find((s) => s.name === 'Product.description');
    expect(col).toBeDefined();
    expect(col!.frameworkMeta?.nullable).toBe(true);
  });
});

// ─── @hybrid_property ─────────────────────────────────────────────────────────

describe('sqlalchemyAdapter — @hybrid_property', () => {
  it('emits const symbol for @hybrid_property', () => {
    const source = `
from sqlalchemy.orm import declarative_base
from sqlalchemy import Column, Integer, String
from sqlalchemy.ext.hybrid import hybrid_property

Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    first_name = Column(String)
    last_name = Column(String)

    @hybrid_property
    def full_name(self):
        return self.first_name + " " + self.last_name
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    const hp = symbols.find((s) => s.name === 'User.full_name');
    expect(hp).toBeDefined();
    expect(hp!.kind).toBe('const');
    expect(hp!.frameworkMeta?.hybrid_property).toBe(true);
  });

  it('does not emit @hybrid_property without following def', () => {
    const source = `
from sqlalchemy.orm import declarative_base
from sqlalchemy import Column, Integer

Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)

    @hybrid_property
    # missing def — just a comment
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    expect(symbols.filter((s) => s.frameworkMeta?.hybrid_property)).toHaveLength(0);
  });
});

// ─── Multiple models in one file ───────────────────────────────────────────────

describe('sqlalchemyAdapter — multiple models', () => {
  it('handles multiple SA model classes in one file', () => {
    const source = `
from sqlalchemy.orm import declarative_base, relationship
from sqlalchemy import Column, Integer, String, ForeignKey

Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    name = Column(String)

class Order(Base):
    __tablename__ = "orders"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"))
`;
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, buf(source), 'models.py');
    const models = symbols.filter((s) => s.frameworkMeta?.sqlalchemy_model);
    expect(models.map((m) => m.name)).toContain('User');
    expect(models.map((m) => m.name)).toContain('Order');

    const userCol = symbols.find((s) => s.name === 'User.name');
    const orderCol = symbols.find((s) => s.name === 'Order.user_id');
    expect(userCol).toBeDefined();
    expect(orderCol).toBeDefined();
  });
});

// ─── enrichMetadata ───────────────────────────────────────────────────────────

describe('sqlalchemyAdapter.enrichMetadata', () => {
  it('returns symbol unchanged', () => {
    const sym = {
      id: 'abc123',
      name: 'User',
      kind: 'class' as const,
      filePath: 'models.py',
      startByte: 0,
      endByte: 0,
      signature: 'class User(Base)',
      summary: 'SQLAlchemy model: User (table: users)',
      frameworkMeta: { sqlalchemy_model: true, table_name: 'users' },
    };
    expect(sqlalchemyAdapter.enrichMetadata!(sym)).toStrictEqual(sym);
  });
});

// ─── Fixture project ──────────────────────────────────────────────────────────

describe('sqlalchemyAdapter — fixture project (SA 1.x models.py)', () => {
  it('detects fixture as sqlalchemy project', async () => {
    expect(await sqlalchemyAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });

  it('extracts User model with correct table_name from models.py', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'models.py'), 'utf8');
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'models.py');
    const model = symbols.find((s) => s.name === 'User');
    expect(model).toBeDefined();
    expect(model!.frameworkMeta?.sqlalchemy_model).toBe(true);
    expect(model!.frameworkMeta?.table_name).toBe('users');
  });

  it('extracts User.id as INTEGER primary key from models.py', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'models.py'), 'utf8');
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'models.py');
    const pk = symbols.find((s) => s.name === 'User.id');
    expect(pk).toBeDefined();
    expect(pk!.frameworkMeta?.column_type).toBe('INTEGER');
    expect(pk!.frameworkMeta?.primary_key).toBe(true);
  });

  it('extracts User.email with VARCHAR type and nullable=False', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'models.py'), 'utf8');
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'models.py');
    const col = symbols.find((s) => s.name === 'User.email');
    expect(col).toBeDefined();
    expect(col!.frameworkMeta?.column_type).toBe('VARCHAR');
    expect(col!.frameworkMeta?.nullable).toBe(false);
  });

  it('extracts User.orders relationship from models.py', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'models.py'), 'utf8');
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'models.py');
    const rel = symbols.find((s) => s.name === 'User.orders');
    expect(rel).toBeDefined();
    expect(rel!.frameworkMeta?.relationship).toBe('Order');
    expect(rel!.frameworkMeta?.back_populates).toBe('user');
  });

  it('extracts User.display_name hybrid property from models.py', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'models.py'), 'utf8');
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'models.py');
    const hp = symbols.find((s) => s.name === 'User.display_name');
    expect(hp).toBeDefined();
    expect(hp!.frameworkMeta?.hybrid_property).toBe(true);
  });

  it('defaults table_name to lowercase class name for Product model', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'models.py'), 'utf8');
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'models.py');
    const model = symbols.find((s) => s.name === 'Product');
    expect(model?.frameworkMeta?.table_name).toBe('product');
  });
});

describe('sqlalchemyAdapter — fixture project (SA 2.0 models_v2.py)', () => {
  it('extracts Category model with table_name from models_v2.py', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'models_v2.py'), 'utf8');
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'models_v2.py');
    const model = symbols.find((s) => s.name === 'Category');
    expect(model).toBeDefined();
    expect(model!.frameworkMeta?.table_name).toBe('categories');
  });

  it('extracts Category.id as INTEGER primary key (SA 2.0)', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'models_v2.py'), 'utf8');
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'models_v2.py');
    const pk = symbols.find((s) => s.name === 'Category.id');
    expect(pk).toBeDefined();
    expect(pk!.frameworkMeta?.column_type).toBe('INTEGER');
    expect(pk!.frameworkMeta?.primary_key).toBe(true);
  });

  it('extracts Category.name with VARCHAR type (SA 2.0)', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'models_v2.py'), 'utf8');
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'models_v2.py');
    const col = symbols.find((s) => s.name === 'Category.name');
    expect(col).toBeDefined();
    expect(col!.frameworkMeta?.column_type).toBe('VARCHAR');
    expect(col!.frameworkMeta?.nullable).toBe(false);
  });

  it('extracts Product2.price as FLOAT (SA 2.0)', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'models_v2.py'), 'utf8');
    const symbols = sqlalchemyAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'models_v2.py');
    const col = symbols.find((s) => s.name === 'Product2.price');
    expect(col).toBeDefined();
    expect(col!.frameworkMeta?.column_type).toBe('FLOAT');
  });
});
