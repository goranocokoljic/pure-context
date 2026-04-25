import { useNavigate } from 'react-router-dom';

export default function NotFound() {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
      <p className="text-6xl font-bold text-gray-800">404</p>
      <p className="text-gray-400">Page not found</p>
      <button
        onClick={() => navigate('/')}
        className="px-4 py-2 bg-blue-600 rounded text-sm hover:bg-blue-700 transition-colors"
      >
        Go home
      </button>
    </div>
  );
}
