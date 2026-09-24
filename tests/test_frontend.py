import unittest

from fastapi.testclient import TestClient

from optviewer.server import app


class FrontendTest(unittest.TestCase):
    def test_frontend_served(self):
        client = TestClient(app)
        self.assertIn("pyOptViewer", client.get("/").text)
        for path in ("/static/js/main.js", "/static/style.css", "/assets/favicon.svg"):
            self.assertEqual(client.get(path).status_code, 200, path)


if __name__ == "__main__":
    unittest.main()
