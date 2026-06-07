import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Home } from './pages/Home';
import { Search } from './pages/Search';
import { Browse } from './pages/Browse';
import { Package } from './pages/Package';

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/search" element={<Search />} />
          <Route path="/packages" element={<Browse />} />
          <Route path="/p/:name" element={<Package />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
