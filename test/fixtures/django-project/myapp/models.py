from django.db import models
from django.contrib.auth.models import AbstractUser


class UserManager(models.Manager):
    def active(self):
        return self.filter(is_active=True)


class User(models.Model):
    """Application user model."""
    username = models.CharField(max_length=150)
    email = models.EmailField(unique=True)
    bio = models.TextField(blank=True, null=True)
    score = models.IntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    objects = UserManager()

    class Meta:
        db_table = 'auth_user'
        verbose_name = 'user'
        ordering = ['-created_at']

    def __str__(self):
        return self.username


class Post(models.Model):
    """Blog post model."""
    title = models.CharField(max_length=200)
    body = models.TextField()
    author = models.ForeignKey(User, on_delete=models.CASCADE)
    published = models.BooleanField(default=False)

    def __str__(self):
        return self.title


class Tag(models.Model):
    name = models.CharField(max_length=50, unique=True)
    posts = models.ManyToManyField(Post, related_name='tags')


class Profile(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE)
    avatar = models.ImageField(upload_to='avatars/', null=True, blank=True)
    website = models.URLField(blank=True)

    class Meta:
        db_table = 'user_profiles'


class PlainPythonClass:
    """Not a Django model — should not be extracted as model."""
    pass
