import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.demo_context import Principal
from app.graph import chat

TEST_QUESTIONS = [
    "What is the ticket size for RTS?",
    "What is the permitted rate of interest under RTS?",
    "What are the different loan types?",
    "Compare Type 1 and Type 2.",
    "What happens if the customer has no income proof?",
    "What is the policy for buying cryptocurrency with an enterprise loan?", # absent from uploaded policy
    "What are the eligibility criteria and documentation required across RTS?" # multi-page query
]

def main():
    p = Principal(tenant="demo-workspace", admin=True)
    for i, q in enumerate(TEST_QUESTIONS, 1):
        print(f"\n==========================================")
        print(f"TEST {i}: {q}")
        print(f"==========================================")
        try:
            result = chat(p, q)
            print("STATUS:", result.get("status"))
            print("ANSWER:\n", result.get("answer"))
            print("\nSOURCES:")
            for s in result.get("sources", []):
                print(f"  [{s['index']}] {s['title']} — page {s['page']}")
        except Exception as e:
            print("ERROR:", e)

if __name__ == "__main__":
    main()

