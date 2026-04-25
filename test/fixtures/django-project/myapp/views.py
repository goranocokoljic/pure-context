from django.shortcuts import render, get_object_or_404
from django.contrib.auth.decorators import login_required, permission_required
from django.views import View
from django.views.generic import ListView, DetailView
from rest_framework.views import APIView
from rest_framework.viewsets import ModelViewSet
from rest_framework.decorators import api_view
from rest_framework.response import Response
from .models import User, Post


# ── Class-based views ──────────────────────────────────────────────────────────

class UserListView(ListView):
    """List all users."""
    model = User
    template_name = 'users/list.html'


class UserDetailView(DetailView):
    """Show a single user."""
    model = User
    template_name = 'users/detail.html'


class UserAPIView(APIView):
    """REST API view for users."""

    def get(self, request):
        return Response({'users': []})

    def post(self, request):
        return Response({'created': True}, status=201)


class PostViewSet(ModelViewSet):
    """ViewSet for Post CRUD operations."""
    queryset = Post.objects.all()


# ── Function-based views ───────────────────────────────────────────────────────

@login_required
def dashboard(request):
    """User dashboard — requires login."""
    return render(request, 'dashboard.html')


@permission_required('myapp.can_publish')
def publish_post(request, post_id):
    """Publish a post — requires publish permission."""
    post = get_object_or_404(Post, pk=post_id)
    post.published = True
    post.save()
    return render(request, 'post_published.html', {'post': post})


@api_view(['GET', 'POST'])
def user_list_api(request):
    """DRF function-based API view."""
    if request.method == 'GET':
        return Response({'users': []})
    return Response({'created': True}, status=201)


def plain_helper(request):
    """Plain function — no view decorator, should not be extracted as view."""
    return render(request, 'base.html')
