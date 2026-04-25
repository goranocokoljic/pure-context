import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { djangoOrmAdapter } from '../../src/adapters/django-orm.js';
import { _resetForTesting } from '../../src/adapters/adapter-registry.js';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/django-project');

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-django-orm-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  _resetForTesting();
});

// ─── Adapter metadata ─────────────────────────────────────────────────────────

describe('djangoOrmAdapter metadata', () => {
  it('has name "django-orm"', () => {
    expect(djangoOrmAdapter.name).toBe('django-orm');
  });

  it('declares no extra extensions', () => {
    expect(djangoOrmAdapter.extensions()).toEqual([]);
  });
});

// ─── Detection ────────────────────────────────────────────────────────────────

describe('djangoOrmAdapter.detect', () => {
  it('detects via manage.py presence', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'manage.py'), '#!/usr/bin/env python\n');
    expect(await djangoOrmAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects Django in requirements.txt', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'requirements.txt'), 'Django>=4.2\n');
    expect(await djangoOrmAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects lowercase django in requirements.txt', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'requirements.txt'), 'django==4.0\n');
    expect(await djangoOrmAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects Django in pyproject.toml', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'pyproject.toml'),
      '[project]\ndependencies = ["Django>=4.2"]\n',
    );
    expect(await djangoOrmAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('returns false when django is absent', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'requirements.txt'), 'fastapi>=0.100\n');
    expect(await djangoOrmAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('returns false without any project files', async () => {
    const dir = tmpDir();
    expect(await djangoOrmAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('detects fixture django project via manage.py', async () => {
    expect(await djangoOrmAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });
});

// ─── File filter ──────────────────────────────────────────────────────────────

describe('djangoOrmAdapter.fileFilter', () => {
  it('accepts models.py at root', () => {
    expect(djangoOrmAdapter.fileFilter('models.py')).toBe(true);
  });

  it('accepts myapp/models.py', () => {
    expect(djangoOrmAdapter.fileFilter('myapp/models.py')).toBe(true);
  });

  it('accepts file inside models/ directory', () => {
    expect(djangoOrmAdapter.fileFilter('myapp/models/user.py')).toBe(true);
    expect(djangoOrmAdapter.fileFilter('myapp/models/post.py')).toBe(true);
  });

  it('rejects views.py', () => {
    expect(djangoOrmAdapter.fileFilter('myapp/views.py')).toBe(false);
  });

  it('rejects urls.py', () => {
    expect(djangoOrmAdapter.fileFilter('myapp/urls.py')).toBe(false);
  });

  it('rejects non-Python files', () => {
    expect(djangoOrmAdapter.fileFilter('requirements.txt')).toBe(false);
    expect(djangoOrmAdapter.fileFilter('manage.py')).toBe(false);
    expect(djangoOrmAdapter.fileFilter('schema.sql')).toBe(false);
  });

  it('rejects arbitrary .py files not named models.py', () => {
    expect(djangoOrmAdapter.fileFilter('myapp/serializers.py')).toBe(false);
    expect(djangoOrmAdapter.fileFilter('myapp/admin.py')).toBe(false);
  });
});

// ─── Model class extraction ───────────────────────────────────────────────────

describe('djangoOrmAdapter — model class', () => {
  it('emits class symbol with django_model for models.Model subclass', () => {
    const source = `
from django.db import models

class User(models.Model):
    username = models.CharField(max_length=150)
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'myapp/models.py');
    const model = symbols.find((s) => s.name === 'User');
    expect(model).toBeDefined();
    expect(model!.kind).toBe('class');
    expect(model!.frameworkMeta?.django_model).toBe(true);
  });

  it('does not emit symbol for plain Python class', () => {
    const source = `
from django.db import models

class PlainClass:
    pass
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'myapp/models.py');
    expect(symbols.filter((s) => s.frameworkMeta?.django_model)).toHaveLength(0);
  });

  it('does not emit symbols when no django import present', () => {
    const source = `
class User(models.Model):
    username = models.CharField(max_length=150)
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'myapp/models.py');
    expect(symbols).toHaveLength(0);
  });

  it('skips files that are not models.py / models/*.py via fileFilter', () => {
    expect(djangoOrmAdapter.fileFilter('myapp/views.py')).toBe(false);
  });
});

// ─── table_name ───────────────────────────────────────────────────────────────

describe('djangoOrmAdapter — table_name', () => {
  it('defaults to app_modelname (Django convention)', () => {
    const source = `
from django.db import models

class Post(models.Model):
    title = models.CharField(max_length=200)
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'blog/models.py');
    const model = symbols.find((s) => s.name === 'Post');
    expect(model?.frameworkMeta?.table_name).toBe('blog_post');
  });

  it('uses Meta.db_table when specified', () => {
    const source = `
from django.db import models

class User(models.Model):
    username = models.CharField(max_length=150)

    class Meta:
        db_table = 'auth_user'
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'accounts/models.py');
    const model = symbols.find((s) => s.name === 'User');
    expect(model?.frameworkMeta?.table_name).toBe('auth_user');
  });

  it('uses single-quoted Meta.db_table', () => {
    const source = `
from django.db import models

class Order(models.Model):
    total = models.DecimalField(max_digits=10, decimal_places=2)

    class Meta:
        db_table = 'shop_orders'
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'shop/models.py');
    const model = symbols.find((s) => s.name === 'Order');
    expect(model?.frameworkMeta?.table_name).toBe('shop_orders');
  });

  it('extracts app_label from file path', () => {
    const source = `
from django.db import models

class Item(models.Model):
    name = models.CharField(max_length=100)
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'inventory/models.py');
    const model = symbols.find((s) => s.name === 'Item');
    expect(model?.frameworkMeta?.app_label).toBe('inventory');
  });
});

// ─── Meta class extraction ────────────────────────────────────────────────────

describe('djangoOrmAdapter — Meta class', () => {
  it('extracts verbose_name from Meta', () => {
    const source = `
from django.db import models

class BlogPost(models.Model):
    title = models.CharField(max_length=200)

    class Meta:
        verbose_name = 'blog post'
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'blog/models.py');
    const model = symbols.find((s) => s.name === 'BlogPost');
    expect(model?.frameworkMeta?.verbose_name).toBe('blog post');
  });

  it('extracts ordering from Meta', () => {
    const source = `
from django.db import models

class Article(models.Model):
    title = models.CharField(max_length=200)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'news/models.py');
    const model = symbols.find((s) => s.name === 'Article');
    expect(model?.frameworkMeta?.ordering).toBe("['- created_at']".replace(' ', ''));
  });

  it('extracts all Meta fields together', () => {
    const source = `
from django.db import models

class Product(models.Model):
    name = models.CharField(max_length=100)

    class Meta:
        db_table = 'store_products'
        verbose_name = 'product'
        ordering = ['name']
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'store/models.py');
    const model = symbols.find((s) => s.name === 'Product');
    expect(model?.frameworkMeta?.table_name).toBe('store_products');
    expect(model?.frameworkMeta?.verbose_name).toBe('product');
    expect(model?.frameworkMeta?.ordering).toBe("['name']");
  });
});

// ─── CharField / text field extraction ───────────────────────────────────────

describe('djangoOrmAdapter — CharField and text fields', () => {
  it('extracts CharField with max_length', () => {
    const source = `
from django.db import models

class User(models.Model):
    username = models.CharField(max_length=150)
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'myapp/models.py');
    const field = symbols.find((s) => s.name === 'User.username');
    expect(field).toBeDefined();
    expect(field!.kind).toBe('const');
    expect(field!.frameworkMeta?.field_type).toBe('CharField');
    expect(field!.frameworkMeta?.column_type).toBe('VARCHAR');
    expect(field!.frameworkMeta?.max_length).toBe(150);
  });

  it('extracts EmailField', () => {
    const source = `
from django.db import models

class User(models.Model):
    email = models.EmailField(unique=True)
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'myapp/models.py');
    const field = symbols.find((s) => s.name === 'User.email');
    expect(field?.frameworkMeta?.field_type).toBe('EmailField');
    expect(field?.frameworkMeta?.column_type).toBe('VARCHAR');
  });

  it('extracts TextField', () => {
    const source = `
from django.db import models

class Post(models.Model):
    body = models.TextField()
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'blog/models.py');
    const field = symbols.find((s) => s.name === 'Post.body');
    expect(field?.frameworkMeta?.field_type).toBe('TextField');
    expect(field?.frameworkMeta?.column_type).toBe('TEXT');
  });

  it('captures null=True', () => {
    const source = `
from django.db import models

class User(models.Model):
    bio = models.TextField(null=True, blank=True)
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'myapp/models.py');
    const field = symbols.find((s) => s.name === 'User.bio');
    expect(field?.frameworkMeta?.null).toBe(true);
    expect(field?.frameworkMeta?.blank).toBe(true);
  });

  it('captures blank=True without null', () => {
    const source = `
from django.db import models

class Post(models.Model):
    subtitle = models.CharField(max_length=200, blank=True)
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'blog/models.py');
    const field = symbols.find((s) => s.name === 'Post.subtitle');
    expect(field?.frameworkMeta?.blank).toBe(true);
    expect(field?.frameworkMeta?.null).toBeUndefined();
  });
});

// ─── Numeric field extraction ─────────────────────────────────────────────────

describe('djangoOrmAdapter — numeric fields', () => {
  it('extracts IntegerField as INTEGER', () => {
    const source = `
from django.db import models

class Product(models.Model):
    stock = models.IntegerField(default=0)
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'shop/models.py');
    const field = symbols.find((s) => s.name === 'Product.stock');
    expect(field?.frameworkMeta?.field_type).toBe('IntegerField');
    expect(field?.frameworkMeta?.column_type).toBe('INTEGER');
  });

  it('extracts FloatField as FLOAT', () => {
    const source = `
from django.db import models

class Measurement(models.Model):
    value = models.FloatField()
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'myapp/models.py');
    const field = symbols.find((s) => s.name === 'Measurement.value');
    expect(field?.frameworkMeta?.column_type).toBe('FLOAT');
  });

  it('extracts DecimalField as DECIMAL', () => {
    const source = `
from django.db import models

class Order(models.Model):
    total = models.DecimalField(max_digits=10, decimal_places=2)
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'shop/models.py');
    const field = symbols.find((s) => s.name === 'Order.total');
    expect(field?.frameworkMeta?.field_type).toBe('DecimalField');
    expect(field?.frameworkMeta?.column_type).toBe('DECIMAL');
  });

  it('extracts BooleanField as BOOLEAN', () => {
    const source = `
from django.db import models

class Post(models.Model):
    published = models.BooleanField(default=False)
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'blog/models.py');
    const field = symbols.find((s) => s.name === 'Post.published');
    expect(field?.frameworkMeta?.column_type).toBe('BOOLEAN');
  });
});

// ─── Date/time field extraction ───────────────────────────────────────────────

describe('djangoOrmAdapter — date/time fields', () => {
  it('extracts DateTimeField as TIMESTAMP', () => {
    const source = `
from django.db import models

class Event(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'events/models.py');
    const field = symbols.find((s) => s.name === 'Event.created_at');
    expect(field?.frameworkMeta?.field_type).toBe('DateTimeField');
    expect(field?.frameworkMeta?.column_type).toBe('TIMESTAMP');
  });

  it('extracts DateField as DATE', () => {
    const source = `
from django.db import models

class Schedule(models.Model):
    date = models.DateField()
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'myapp/models.py');
    const field = symbols.find((s) => s.name === 'Schedule.date');
    expect(field?.frameworkMeta?.column_type).toBe('DATE');
  });
});

// ─── Relationship field extraction ────────────────────────────────────────────

describe('djangoOrmAdapter — ForeignKey', () => {
  it('extracts ForeignKey with on_delete', () => {
    const source = `
from django.db import models

class Post(models.Model):
    author = models.ForeignKey(User, on_delete=models.CASCADE)
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'blog/models.py');
    const rel = symbols.find((s) => s.name === 'Post.author');
    expect(rel).toBeDefined();
    expect(rel!.kind).toBe('const');
    expect(rel!.frameworkMeta?.relationship).toBe('many_to_one');
    expect(rel!.frameworkMeta?.target_model).toBe('User');
    expect(rel!.frameworkMeta?.on_delete).toBe('CASCADE');
  });

  it('extracts ForeignKey with quoted model name', () => {
    const source = `
from django.db import models

class Comment(models.Model):
    post = models.ForeignKey('Post', on_delete=models.CASCADE)
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'blog/models.py');
    const rel = symbols.find((s) => s.name === 'Comment.post');
    expect(rel?.frameworkMeta?.target_model).toBe('Post');
  });

  it('extracts ForeignKey with on_delete=SET_NULL', () => {
    const source = `
from django.db import models

class Article(models.Model):
    category = models.ForeignKey(Category, on_delete=models.SET_NULL, null=True)
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'news/models.py');
    const rel = symbols.find((s) => s.name === 'Article.category');
    expect(rel?.frameworkMeta?.on_delete).toBe('SET_NULL');
  });
});

describe('djangoOrmAdapter — ManyToManyField', () => {
  it('extracts ManyToManyField', () => {
    const source = `
from django.db import models

class Tag(models.Model):
    posts = models.ManyToManyField(Post, related_name='tags')
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'blog/models.py');
    const rel = symbols.find((s) => s.name === 'Tag.posts');
    expect(rel).toBeDefined();
    expect(rel!.frameworkMeta?.relationship).toBe('many_to_many');
    expect(rel!.frameworkMeta?.target_model).toBe('Post');
  });

  it('extracts ManyToManyField with quoted target', () => {
    const source = `
from django.db import models

class Post(models.Model):
    tags = models.ManyToManyField('Tag')
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'blog/models.py');
    const rel = symbols.find((s) => s.name === 'Post.tags');
    expect(rel?.frameworkMeta?.target_model).toBe('Tag');
  });
});

describe('djangoOrmAdapter — OneToOneField', () => {
  it('extracts OneToOneField', () => {
    const source = `
from django.db import models

class Profile(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE)
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'accounts/models.py');
    const rel = symbols.find((s) => s.name === 'Profile.user');
    expect(rel).toBeDefined();
    expect(rel!.frameworkMeta?.relationship).toBe('one_to_one');
    expect(rel!.frameworkMeta?.target_model).toBe('User');
  });
});

// ─── Custom manager extraction ────────────────────────────────────────────────

describe('djangoOrmAdapter — custom manager', () => {
  it('extracts custom manager assignment', () => {
    const source = `
from django.db import models

class PostManager(models.Manager):
    pass

class Post(models.Model):
    title = models.CharField(max_length=200)
    objects = PostManager()
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'blog/models.py');
    const mgr = symbols.find((s) => s.name === 'Post.objects');
    expect(mgr).toBeDefined();
    expect(mgr!.kind).toBe('const');
    expect(mgr!.frameworkMeta?.django_manager).toBe(true);
  });

  it('extracts manager with custom name', () => {
    const source = `
from django.db import models

class ActiveManager(models.Manager):
    pass

class User(models.Model):
    username = models.CharField(max_length=150)
    active = ActiveManager()
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'myapp/models.py');
    const mgr = symbols.find((s) => s.name === 'User.active');
    expect(mgr?.frameworkMeta?.django_manager).toBe(true);
  });
});

// ─── Multiple models in one file ───────────────────────────────────────────────

describe('djangoOrmAdapter — multiple models', () => {
  it('handles multiple model classes in one file', () => {
    const source = `
from django.db import models

class User(models.Model):
    username = models.CharField(max_length=150)

class Post(models.Model):
    title = models.CharField(max_length=200)
    author = models.ForeignKey(User, on_delete=models.CASCADE)
`;
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, buf(source), 'myapp/models.py');
    const models = symbols.filter((s) => s.frameworkMeta?.django_model);
    expect(models.map((m) => m.name)).toContain('User');
    expect(models.map((m) => m.name)).toContain('Post');

    expect(symbols.find((s) => s.name === 'User.username')).toBeDefined();
    expect(symbols.find((s) => s.name === 'Post.title')).toBeDefined();
    expect(symbols.find((s) => s.name === 'Post.author')).toBeDefined();
  });
});

// ─── enrichMetadata ───────────────────────────────────────────────────────────

describe('djangoOrmAdapter.enrichMetadata', () => {
  it('returns symbol unchanged', () => {
    const sym = {
      id: 'abc123',
      name: 'User',
      kind: 'class' as const,
      filePath: 'myapp/models.py',
      startByte: 0,
      endByte: 0,
      signature: 'class User(models.Model):',
      summary: 'Django model: User (table: myapp_user)',
      frameworkMeta: { django_model: true, table_name: 'myapp_user', app_label: 'myapp' },
    };
    expect(djangoOrmAdapter.enrichMetadata!(sym)).toStrictEqual(sym);
  });
});

// ─── Fixture project ──────────────────────────────────────────────────────────

describe('djangoOrmAdapter — fixture project', () => {
  it('detects fixture as django project', async () => {
    expect(await djangoOrmAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });

  it('extracts User model with db_table from Meta', () => {
    const source = readFileSync(`${FIXTURE_ROOT}/myapp/models.py`, 'utf8');
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'myapp/models.py');
    const model = symbols.find((s) => s.name === 'User');
    expect(model).toBeDefined();
    expect(model!.frameworkMeta?.django_model).toBe(true);
    expect(model!.frameworkMeta?.table_name).toBe('auth_user');
  });

  it('extracts User.username with max_length', () => {
    const source = readFileSync(`${FIXTURE_ROOT}/myapp/models.py`, 'utf8');
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'myapp/models.py');
    const field = symbols.find((s) => s.name === 'User.username');
    expect(field).toBeDefined();
    expect(field!.frameworkMeta?.field_type).toBe('CharField');
    expect(field!.frameworkMeta?.max_length).toBe(150);
  });

  it('extracts User.bio with null=True and blank=True', () => {
    const source = readFileSync(`${FIXTURE_ROOT}/myapp/models.py`, 'utf8');
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'myapp/models.py');
    const field = symbols.find((s) => s.name === 'User.bio');
    expect(field?.frameworkMeta?.null).toBe(true);
    expect(field?.frameworkMeta?.blank).toBe(true);
  });

  it('extracts User.objects as custom manager', () => {
    const source = readFileSync(`${FIXTURE_ROOT}/myapp/models.py`, 'utf8');
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'myapp/models.py');
    const mgr = symbols.find((s) => s.name === 'User.objects');
    expect(mgr).toBeDefined();
    expect(mgr!.frameworkMeta?.django_manager).toBe(true);
  });

  it('extracts User Meta verbose_name', () => {
    const source = readFileSync(`${FIXTURE_ROOT}/myapp/models.py`, 'utf8');
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'myapp/models.py');
    const model = symbols.find((s) => s.name === 'User');
    expect(model?.frameworkMeta?.verbose_name).toBe('user');
  });

  it('extracts Post.author as ForeignKey', () => {
    const source = readFileSync(`${FIXTURE_ROOT}/myapp/models.py`, 'utf8');
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'myapp/models.py');
    const rel = symbols.find((s) => s.name === 'Post.author');
    expect(rel).toBeDefined();
    expect(rel!.frameworkMeta?.relationship).toBe('many_to_one');
    expect(rel!.frameworkMeta?.target_model).toBe('User');
    expect(rel!.frameworkMeta?.on_delete).toBe('CASCADE');
  });

  it('extracts Tag.posts as ManyToManyField', () => {
    const source = readFileSync(`${FIXTURE_ROOT}/myapp/models.py`, 'utf8');
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'myapp/models.py');
    const rel = symbols.find((s) => s.name === 'Tag.posts');
    expect(rel).toBeDefined();
    expect(rel!.frameworkMeta?.relationship).toBe('many_to_many');
    expect(rel!.frameworkMeta?.target_model).toBe('Post');
  });

  it('extracts Profile.user as OneToOneField', () => {
    const source = readFileSync(`${FIXTURE_ROOT}/myapp/models.py`, 'utf8');
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'myapp/models.py');
    const rel = symbols.find((s) => s.name === 'Profile.user');
    expect(rel).toBeDefined();
    expect(rel!.frameworkMeta?.relationship).toBe('one_to_one');
  });

  it('extracts Profile with db_table from Meta', () => {
    const source = readFileSync(`${FIXTURE_ROOT}/myapp/models.py`, 'utf8');
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'myapp/models.py');
    const model = symbols.find((s) => s.name === 'Profile');
    expect(model?.frameworkMeta?.table_name).toBe('user_profiles');
  });

  it('does not extract PlainPythonClass as model', () => {
    const source = readFileSync(`${FIXTURE_ROOT}/myapp/models.py`, 'utf8');
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'myapp/models.py');
    expect(symbols.find((s) => s.name === 'PlainPythonClass')).toBeUndefined();
  });

  it('extracts all four models from fixture', () => {
    const source = readFileSync(`${FIXTURE_ROOT}/myapp/models.py`, 'utf8');
    const symbols = djangoOrmAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'myapp/models.py');
    const modelNames = symbols.filter((s) => s.frameworkMeta?.django_model).map((s) => s.name);
    expect(modelNames).toContain('User');
    expect(modelNames).toContain('Post');
    expect(modelNames).toContain('Tag');
    expect(modelNames).toContain('Profile');
  });
});
