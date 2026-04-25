export default defineNuxtRouteMiddleware((to) => {
  const isAuthenticated = false; // stub
  if (!isAuthenticated && to.path !== '/login') {
    return navigateTo('/login');
  }
});
