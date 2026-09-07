# Byzantine Quorum Intersection

Let $n$ denote the total number of nodes and $f$ the maximum number of Byzantine faulty
nodes tolerated by the protocol \cite{castro_liskov_1999}.

$$n_{\min} = 3f + 1$$

> **Theorem 3.2 (Quorum Intersection Bound):** Any two quorums of size at least
> $2f + 1$ intersect in at least one correct node, so the protocol is safe whenever
> $n \geq 3f + 1$ \cite{castro_liskov_1999}.

The bound also appears in the pandoc-style citation form [@lamport_1982] and can be
compared against classical crash-fault results.

| Model       | Resilience bound | Source                    |
| ----------- | ---------------- | ------------------------- |
| Crash-fault | $n \geq 2f + 1$  | [@lamport_1982]           |
| Byzantine   | $n \geq 3f + 1$  | \cite{castro_liskov_1999} |

```python
def quorum_size(n: int) -> int:
    return (n + 1) // 2
```
