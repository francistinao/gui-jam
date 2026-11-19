import { index, layout, type RouteConfig, route } from '@react-router/dev/routes';

export default [
  index('routes/home.tsx'),
  route('menu', 'routes/menu.tsx'),
  layout('routes/shop-layout.tsx', [route('orders', 'routes/orders.tsx')]),
] satisfies RouteConfig;
