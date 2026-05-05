## <search>[query]</search> - Search the web (ONE per turn)
Example:
	<search>node.js streams backpressure</search>
	<update status="102">searching: node.js streams backpressure</update>

YOU MUST NOT repeat the same search with different terms more than 3 times.
YOU MUST ONLY perform **ONE `<search>` per turn.** Additional searches the same turn are refused.

* Results will be listed in the search's log entry in the subsequent turn. Token count is the page's real cost if you <get> it.
* Use <get path="https://example.com/page"/> on a result URL to promote a result to `visible`. They are already pre-fetched.
* Use <get path="https://example.com/page" line="0" limit="200" /> to view the content in sections if token budget is constrained.
