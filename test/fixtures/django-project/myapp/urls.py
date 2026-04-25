from django.urls import path, re_path
from . import views

urlpatterns = [
    path('users/', views.UserListView.as_view(), name='user-list'),
    path('users/<int:pk>/', views.UserDetailView.as_view(), name='user-detail'),
    path('users/<int:pk>/posts/', views.UserAPIView.as_view(), name='user-posts'),
    path('dashboard/', views.dashboard, name='dashboard'),
    re_path(r'^legacy/users/(?P<username>\w+)/$', views.UserDetailView.as_view()),
]
