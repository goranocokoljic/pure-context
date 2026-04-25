import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { djangoAdapter } from '../../src/adapters/django.js';
import { _resetForTesting } from '../../src/adapters/adapter-registry.js';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/django-project');

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-django-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  _resetForTesting();
});

// ─── Adapter metadata ─────────────────────────────────────────────────────────

describe('djangoAdapter metadata', () => {
  it('has name "django"', () => {
    expect(djangoAdapter.name).toBe('django');
  });

  it('declares no extra extensions', () => {
    expect(djangoAdapter.extensions()).toEqual([]);
  });
});

// ─── Detection ────────────────────────────────────────────────────────────────

describe('djangoAdapter.detect', () => {
  it('detects via manage.py presence', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'manage.py'), '#!/usr/bin/env python\n');
    expect(await djangoAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects Django in requirements.txt', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'requirements.txt'), 'Django>=4.2\n');
    expect(await djangoAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects lowercase django in requirements.txt', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'requirements.txt'), 'django==3.2\n');
    expect(await djangoAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('detects Django in pyproject.toml', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\ndependencies = ["Django>=4.2"]\n');
    expect(await djangoAdapter.detect(dir)).toBe(true);
    rmSync(dir, { recursive: true });
  });

  it('returns false when absent', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'requirements.txt'), 'fastapi>=0.100\n');
    expect(await djangoAdapter.detect(dir)).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('detects fixture django project via manage.py', async () => {
    expect(await djangoAdapter.detect(FIXTURE_ROOT)).toBe(true);
  });
});

// ─── File filter ──────────────────────────────────────────────────────────────

describe('djangoAdapter.fileFilter', () => {
  it('accepts .py files', () => {
    expect(djangoAdapter.fileFilter('myapp/models.py')).toBe(true);
  });

  it('rejects non-Python files', () => {
    expect(djangoAdapter.fileFilter('requirements.txt')).toBe(false);
    expect(djangoAdapter.fileFilter('manage.py')).toBe(false); // it ends with .py but basename is manage.py
  });
});

// ─── Model extraction ─────────────────────────────────────────────────────────

describe('djangoAdapter — model extraction', () => {
  it('extracts models.Model subclass', () => {
    const source = `
from django.db import models

class User(models.Model):
    username = models.CharField(max_length=150)
`;
    const symbols = djangoAdapter.extractFrameworkSymbols(null, buf(source), 'myapp/models.py');
    const model = symbols.find((s) => s.name === 'User' && s.kind === 'model');
    expect(model).toBeDefined();
    expect(model!.frameworkMeta?.django_model).toBe(true);
  });

  it('extracts multiple models from the same file', () => {
    const source = `
from django.db import models

class Post(models.Model):
    title = models.CharField(max_length=200)

class Tag(models.Model):
    name = models.CharField(max_length=50)
`;
    const symbols = djangoAdapter.extractFrameworkSymbols(null, buf(source), 'myapp/models.py');
    const names = symbols.filter((s) => s.kind === 'model').map((s) => s.name);
    expect(names).toContain('Post');
    expect(names).toContain('Tag');
  });

  it('does not extract plain Python classes as models', () => {
    const source = `
from django.db import models

class PlainClass:
    pass
`;
    const symbols = djangoAdapter.extractFrameworkSymbols(null, buf(source), 'myapp/models.py');
    expect(symbols.find((s) => s.name === 'PlainClass')).toBeUndefined();
  });

  it('extracts AbstractUser subclass as model', () => {
    const source = `
from django.contrib.auth.models import AbstractUser

class CustomUser(AbstractUser):
    bio = models.TextField(blank=True)
`;
    // Note: this also needs django import — add it
    const source2 = 'from django.db import models\n' + source;
    const symbols = djangoAdapter.extractFrameworkSymbols(null, buf(source2), 'myapp/models.py');
    expect(symbols.find((s) => s.name === 'CustomUser' && s.kind === 'model')).toBeDefined();
  });

  it('extracts all models from fixture models.py', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'myapp/models.py'), 'utf8');
    const symbols = djangoAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'myapp/models.py');
    const modelNames = symbols.filter((s) => s.kind === 'model').map((s) => s.name);
    expect(modelNames).toContain('User');
    expect(modelNames).toContain('Post');
    expect(modelNames).toContain('Tag');
    expect(modelNames).not.toContain('PlainPythonClass');
  });
});

// ─── CBV view extraction ──────────────────────────────────────────────────────

describe('djangoAdapter — class-based view extraction', () => {
  it('extracts ListView subclass', () => {
    const source = `
from django.views.generic import ListView
from django.views import View

class UserListView(ListView):
    model = User
`;
    const symbols = djangoAdapter.extractFrameworkSymbols(null, buf(source), 'myapp/views.py');
    const view = symbols.find((s) => s.name === 'UserListView' && s.kind === 'view');
    expect(view).toBeDefined();
    expect(view!.frameworkMeta?.django_cbv).toBe(true);
  });

  it('extracts APIView subclass', () => {
    const source = `
from rest_framework.views import APIView

class UserAPIView(APIView):
    def get(self, request):
        pass
`;
    const symbols = djangoAdapter.extractFrameworkSymbols(null, buf(source), 'myapp/views.py');
    expect(symbols.find((s) => s.name === 'UserAPIView' && s.kind === 'view')).toBeDefined();
  });

  it('extracts ModelViewSet subclass', () => {
    const source = `
from rest_framework.viewsets import ModelViewSet

class PostViewSet(ModelViewSet):
    queryset = Post.objects.all()
`;
    const symbols = djangoAdapter.extractFrameworkSymbols(null, buf(source), 'myapp/views.py');
    expect(symbols.find((s) => s.name === 'PostViewSet' && s.kind === 'view')).toBeDefined();
  });

  it('extracts CBVs from fixture views.py', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'myapp/views.py'), 'utf8');
    const symbols = djangoAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'myapp/views.py');
    const viewNames = symbols.filter((s) => s.kind === 'view').map((s) => s.name);
    expect(viewNames).toContain('UserListView');
    expect(viewNames).toContain('UserDetailView');
    expect(viewNames).toContain('UserAPIView');
    expect(viewNames).toContain('PostViewSet');
  });
});

// ─── FBV view extraction ──────────────────────────────────────────────────────

describe('djangoAdapter — function-based view extraction', () => {
  it('extracts @login_required decorated function', () => {
    const source = `
from django.contrib.auth.decorators import login_required

@login_required
def dashboard(request):
    pass
`;
    const symbols = djangoAdapter.extractFrameworkSymbols(null, buf(source), 'myapp/views.py');
    const view = symbols.find((s) => s.name === 'dashboard' && s.kind === 'view');
    expect(view).toBeDefined();
    expect(view!.frameworkMeta?.django_fbv).toBe(true);
  });

  it('extracts @api_view decorated function', () => {
    const source = `
from rest_framework.decorators import api_view

@api_view(['GET', 'POST'])
def user_list_api(request):
    pass
`;
    const symbols = djangoAdapter.extractFrameworkSymbols(null, buf(source), 'myapp/views.py');
    expect(symbols.find((s) => s.name === 'user_list_api' && s.kind === 'view')).toBeDefined();
  });

  it('does not extract plain undecorated function as view', () => {
    const source = `
from django.shortcuts import render

def plain_helper(request):
    return render(request, 'base.html')
`;
    const symbols = djangoAdapter.extractFrameworkSymbols(null, buf(source), 'myapp/views.py');
    expect(symbols.find((s) => s.name === 'plain_helper')).toBeUndefined();
  });

  it('extracts FBVs from fixture views.py', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'myapp/views.py'), 'utf8');
    const symbols = djangoAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'myapp/views.py');
    const fbvNames = symbols.filter((s) => s.kind === 'view' && s.frameworkMeta?.django_fbv).map((s) => s.name);
    expect(fbvNames).toContain('dashboard');
    expect(fbvNames).toContain('publish_post');
    expect(fbvNames).toContain('user_list_api');
    expect(fbvNames).not.toContain('plain_helper');
  });
});

// ─── URL pattern extraction ───────────────────────────────────────────────────

describe('djangoAdapter — URL pattern extraction', () => {
  it('extracts path() URL patterns only from urls.py', () => {
    const source = `
from django.urls import path
from . import views

urlpatterns = [
    path('users/', views.UserListView.as_view()),
    path('users/<int:pk>/', views.UserDetailView.as_view()),
]
`;
    const symbols = djangoAdapter.extractFrameworkSymbols(null, buf(source), 'myapp/urls.py');
    const routes = symbols.filter((s) => s.kind === 'route');
    expect(routes.length).toBeGreaterThanOrEqual(2);
    expect(routes.find((s) => s.name === 'users/')).toBeDefined();
  });

  it('normalises angle-bracket path params', () => {
    const source = `
from django.urls import path
from . import views

urlpatterns = [path('users/<int:pk>/', views.UserDetailView.as_view())]
`;
    const symbols = djangoAdapter.extractFrameworkSymbols(null, buf(source), 'myapp/urls.py');
    expect(symbols.find((s) => s.name === 'users/:pk/')).toBeDefined();
  });

  it('normalises re_path regex named groups', () => {
    const source = `
from django.urls import re_path
from . import views

urlpatterns = [re_path(r'^users/(?P<username>\\w+)/$', views.UserDetailView.as_view())]
`;
    const symbols = djangoAdapter.extractFrameworkSymbols(null, buf(source), 'myapp/urls.py');
    expect(symbols.find((s) => s.name.includes(':username'))).toBeDefined();
  });

  it('does NOT extract path() from non-urls.py files', () => {
    const source = `
from django.urls import path

urlpatterns = [path('users/', views.list_users)]
`;
    const symbols = djangoAdapter.extractFrameworkSymbols(null, buf(source), 'myapp/views.py');
    expect(symbols.filter((s) => s.kind === 'route')).toHaveLength(0);
  });

  it('extracts URL patterns from fixture urls.py', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'myapp/urls.py'), 'utf8');
    const symbols = djangoAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'myapp/urls.py');
    const routes = symbols.filter((s) => s.kind === 'route');
    expect(routes.length).toBeGreaterThanOrEqual(4);
  });
});

// ─── Signal extraction ────────────────────────────────────────────────────────

describe('djangoAdapter — signal extraction', () => {
  it('extracts @receiver decorated function as signal', () => {
    const source = `
from django.dispatch import receiver
from django.db.models.signals import post_save

@receiver(post_save, sender=User)
def on_user_created(sender, instance, **kwargs):
    pass
`;
    const symbols = djangoAdapter.extractFrameworkSymbols(null, buf(source), 'myapp/signals.py');
    const signal = symbols.find((s) => s.name === 'on_user_created' && s.kind === 'signal');
    expect(signal).toBeDefined();
    expect(signal!.frameworkMeta?.django_signal).toBe(true);
    expect(signal!.frameworkMeta?.signal_type).toBe('post_save');
  });

  it('does not extract plain function as signal', () => {
    const source = `
from django.dispatch import receiver

def plain_function():
    pass
`;
    const symbols = djangoAdapter.extractFrameworkSymbols(null, buf(source), 'myapp/signals.py');
    expect(symbols.find((s) => s.name === 'plain_function')).toBeUndefined();
  });

  it('extracts signals from fixture signals.py', () => {
    const source = readFileSync(join(FIXTURE_ROOT, 'myapp/signals.py'), 'utf8');
    const symbols = djangoAdapter.extractFrameworkSymbols(null, Buffer.from(source), 'myapp/signals.py');
    const signalNames = symbols.filter((s) => s.kind === 'signal').map((s) => s.name);
    expect(signalNames).toContain('on_user_created');
    expect(signalNames).toContain('on_post_deleted');
    expect(signalNames).not.toContain('plain_function');
  });
});

// ─── Django import guard ──────────────────────────────────────────────────────

describe('djangoAdapter — Django import guard', () => {
  it('skips files that do not import Django', () => {
    const source = `
class User:
    username = ''

class Post:
    title = ''
`;
    const symbols = djangoAdapter.extractFrameworkSymbols(null, buf(source), 'myapp/models.py');
    expect(symbols).toHaveLength(0);
  });

  it('processes files importing rest_framework', () => {
    const source = `
from rest_framework.views import APIView

class MyView(APIView):
    pass
`;
    const symbols = djangoAdapter.extractFrameworkSymbols(null, buf(source), 'myapp/views.py');
    expect(symbols.find((s) => s.name === 'MyView' && s.kind === 'view')).toBeDefined();
  });
});

// ─── enrichMetadata ───────────────────────────────────────────────────────────

describe('djangoAdapter.enrichMetadata', () => {
  it('returns symbol unchanged', () => {
    const sym = {
      id: 'abc',
      name: 'User',
      kind: 'model' as const,
      filePath: 'myapp/models.py',
      startByte: 0,
      endByte: 0,
      signature: 'class User(models.Model):',
      summary: 'Django model: User',
      frameworkMeta: { django_model: true },
    };
    expect(djangoAdapter.enrichMetadata!(sym)).toStrictEqual(sym);
  });
});
