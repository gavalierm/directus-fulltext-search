"""
Reindex fulltext stĺpca pre songs, albums, setlists, bands.
Spraví PATCH (title=title) v dávkach, čím triggeruje Directus Flow
na prebudovanie fulltext indexu.

Použitie:
  1. Vytvor .env súbor (alebo nastav env premenné):
       DIRECTUS_URL=https://your-directus-instance.example.com
       DIRECTUS_EMAIL=user@example.com
       DIRECTUS_PASSWORD=secret
  2. Spusti:
       python3 reindex-fulltext.py
"""

import os
import requests
import time

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

DIRECTUS_URL = os.environ["DIRECTUS_URL"]
EMAIL = os.environ["DIRECTUS_EMAIL"]
PASSWORD = os.environ["DIRECTUS_PASSWORD"]
BATCH_SIZE = 50
COLLECTIONS = ["songs", "albums", "setlists", "bands"]


def login(session):
    r = session.post(f"{DIRECTUS_URL}/auth/login", json={
        "email": EMAIL,
        "password": PASSWORD,
    })
    r.raise_for_status()
    token = r.json()["data"]["access_token"]
    session.headers["Authorization"] = f"Bearer {token}"


def get_all_ids(session, collection):
    ids = []
    offset = 0
    while True:
        r = session.get(f"{DIRECTUS_URL}/items/{collection}", params={
            "fields": "id,title",
            "limit": 100,
            "offset": offset,
        })
        r.raise_for_status()
        data = r.json()["data"]
        if not data:
            break
        ids.extend([(item["id"], item["title"]) for item in data])
        offset += len(data)
    return ids


def reindex(session, collection, items):
    total = len(items)
    updated = 0
    for i in range(0, total, BATCH_SIZE):
        batch = items[i:i + BATCH_SIZE]
        for item_id, title in batch:
            r = session.patch(
                f"{DIRECTUS_URL}/items/{collection}/{item_id}",
                json={"title": title},
            )
            r.raise_for_status()
            updated += 1
        print(f"  {collection}: {updated}/{total}")
        if i + BATCH_SIZE < total:
            time.sleep(0.5)


def main():
    session = requests.Session()
    print("Prihlasovanie...")
    login(session)
    print("OK\n")

    for collection in COLLECTIONS:
        print(f"Načítavam {collection}...")
        items = get_all_ids(session, collection)
        print(f"  Nájdených: {len(items)}")
        if items:
            reindex(session, collection, items)
        print()

    print("Hotovo.")


if __name__ == "__main__":
    main()
