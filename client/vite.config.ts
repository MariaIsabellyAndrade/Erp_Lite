import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const { PORT } = loadEnv(mode, '..', 'PORT');
  return {
    plugins: [react()],
    envDir: '..',
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${PORT || '3001'}`,
          changeOrigin: true
        }
      }
    }
  };
});
