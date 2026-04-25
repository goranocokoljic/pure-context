from django.db.models.signals import post_save, pre_delete
from django.dispatch import receiver
from .models import User, Post


@receiver(post_save, sender=User)
def on_user_created(sender, instance, created, **kwargs):
    """Send welcome email when a new user is created."""
    if created:
        pass  # send_welcome_email(instance)


@receiver(pre_delete, sender=Post)
def on_post_deleted(sender, instance, **kwargs):
    """Clean up resources when a post is deleted."""
    pass


def plain_function():
    """Not a signal receiver — should not be extracted as signal."""
    pass
