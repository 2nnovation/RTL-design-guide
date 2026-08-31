# Reset Deassertion and RDC

Asynchronous reset assertion과 deassertion은 서로 다른 문제다. Assertion은 state를 빠르게 reset 상태로 보낼 수 있지만, raw deassertion이 destination clock edge 근처에 도착하면 recovery/removal violation, metastability와 partial release를 만들 수 있다.

> 이 문서의 `async_reset_n`과 `local_reset_n`은 active-low다. `0`이 asserted, `1`이 deasserted다. 예제는 asynchronous assertion과 destination-clock synchronized deassertion을 구현한다.

Reset style의 비교는 [Synchronous vs Asynchronous Reset](sync_vs_async_reset.md), data synchronizer의 역할은 [2FF Synchronizer](../08_cdc/synchronizer.md)가 담당한다. Reset release synchronizer를 일반 data/event synchronizer와 같은 만능 구조로 취급하지 않는다.

## 1. 왜 Deassertion이 위험한가

Asynchronous control pin도 clock edge 주변에 release되면 cell-specific timing requirement를 가진다.

```text
                 recovery/removal window
                         <---->
clock        ____/‾‾‾‾‾‾‾\____
async reset  ________/‾‾‾‾‾‾‾‾
                     ↑ raw deassertion
```

Potential effects:

- 한 FF가 metastable해져 reset state에서 늦게 빠져나옴
- 같은 reset tree의 FF들이 서로 다른 cycle에 release됨
- One-hot/FSM/pointer가 illegal combination을 잠시 가짐
- Valid는 풀렸지만 payload/control은 여전히 reset인 partial state
- Related controls가 independently release되어 reconvergence failure
- Rare silicon-only failure that RTL simulation does not reproduce

Recovery/removal의 정의와 숫자는 target cell/library와 analysis method에 의존한다. RTL guide에서 universal timing value를 제시하지 않는다.

## 2. Reset Tree Skew와 Partial Release

```text
raw reset source
       ├──── short route ───> FF A releases near edge N
       └──── long route  ───> FF B releases near edge N+1

FF A + FF B reconverge ───> source에 없던 state 조합
```

Reset tree synthesis가 skew를 줄여도 asynchronous release를 functional clock edge에 안전하게 정렬하는 protocol을 대신하지 않는다. 특히 reset fanout이 넓거나 multiple voltage/physical regions를 통과하면 source deassertion과 local usability를 분리해야 한다.

## 3. Per-domain Controlled Release

일반적인 architecture 방향은 다음과 같다.

```text
async_reset_n
    │ asynchronous assertion
    v
domain A release chain --clk_a--> local_reset_a_n
domain B release chain --clk_b--> local_reset_b_n
domain C release chain --clk_c--> local_reset_c_n
```

각 destination domain은 자기 clock edge로 release를 진행한다. Domain A가 먼저 release되어도 B가 ready가 아닐 수 있으므로 domain 사이 transaction은 `reset_done`, initialization handshake, isolation 또는 valid protocol로 막는다.

Global raw reset deassertion을 하나의 synchronizer에서 처리한 뒤 여러 unrelated clocks에 배포하는 것은 per-domain synchronization이 아니다.

## 4. Fixed Two-stage Reset-release Synchronizer

다음은 active-low reset의 generic structural example다.

Contract:

- `async_reset_n=0`이면 `release_q`와 `local_reset_n`은 clock 없이 0으로 assertion된다.
- `async_reset_n`이 1로 deassert된 뒤 두 clean `clk` edges가 들어오면 digital nominal case에서 `local_reset_n`이 1이 된다.
- First stage가 release edge 근처에서 metastable하면 release는 추가 cycle 지연될 수 있다.
- `release_q[0]`은 containment stage이며 functional fanout을 가지면 안 된다.
- `local_reset_n`은 이 destination domain에서만 사용한다.
- Target flow가 synchronizer chain을 인식·보존하고 recovery/removal/physical requirement를 분석해야 한다.

```systemverilog
module reset_release_sync_2stage (
    input  logic clk,
    input  logic async_reset_n,
    output logic local_reset_n
);
    logic [1:0] release_q;

    // async_reset_n: active-low, asynchronous assertion source.
    // release_q[0]: first-stage metastability containment.
    // release_q[1]: domain-local reset release output.
    always_ff @(posedge clk or negedge async_reset_n) begin
        if (!async_reset_n) begin
            release_q <= 2'b00;
        end else begin
            release_q <= {release_q[0], 1'b1};
        end
    end

    assign local_reset_n = release_q[1];
endmodule
```

Vendor-specific synchronizer/reset attributes는 사용하지 않았다. 실제 flow에서 approved cell, identification metadata, placement와 constraints가 필요할 수 있다.

## 5. Release Latency and NBA Cycle Audit

`async_reset_n`이 E0과 E1 사이에서 high가 되고 E1/E2가 clean edges라고 가정한다.

```text
time / edge                  before E1    after E1    after E2    at E3 sample
async_reset_n                1            1           1           1
release_q                    00           01          11          11
local_reset_n                0            0           1           1
downstream edge behavior     -            reset       reset       first normal edge
```

Important NBA detail:

- E1 active region에서 downstream FF는 `local_reset_n=0`을 sample하므로 reset branch를 유지한다. 이후 NBA로 `release_q=01`이 된다.
- E2에서도 downstream FF는 edge 직전 `local_reset_n=0`을 sample한다. 이후 NBA로 `release_q=11`, `local_reset_n=1`이 된다.
- E3이 downstream state가 `local_reset_n=1`을 sample하는 첫 active edge다.

따라서 “두 edge 뒤 local reset output이 deassert된다”와 “두 번째 edge에서 downstream logic이 normal operation을 한다”를 혼동하지 않는다. 이 예제에서는 nominal하게 E3이 첫 normal downstream edge다.

Asynchronous phase가 E1의 recovery/removal window에 걸리면 first stage resolution 때문에 release가 E3 이후로 늦어질 수 있다. Synchronizer는 failure probability를 target까지 낮추는 containment structure이지 deterministic analog guarantee가 아니다.

## 6. First-stage Metastability Containment

Release chain이 data 2FF와 닮아 보이지만 정보 semantics가 다르다.

```text
constant 1 ─> release_q[0] ─> release_q[1] ─> local_reset_n
                first stage      only usable stage
```

Rules:

- `release_q[0]` output은 debug, enable, ready 또는 다른 functional logic에 사용하지 않는다.
- Stage 사이 combinational logic을 두지 않는다.
- Physical implementation에서 stage 사이 delay와 first-stage fanout을 최소화한다.
- Release output은 destination domain의 reset tree/loads로만 배포한다.
- Required reliability는 clock rate, reset event rate, cell data와 physical resolution opportunity로 확인한다.

Reset chain의 raw async control은 두 stages에 들어가므로 project RDC methodology와 approved structure를 따라야 한다. Code shape만으로 silicon reliability가 보장되지 않는다.

## 7. Reset Pulse Width와 Clock Stability

Reset source requirement:

- Async assertion pulse가 sequential cell/chain의 minimum pulse width를 만족하는가?
- Glitch 또는 source bounce가 reset event로 해석되지 않는가?
- Reset assertion이 power/isolation 상태에서 유효한가?
- Source deassertion 전에 clock source와 supply가 usable한가?

Release clock requirement:

- 두 개 이상의 clean active edges가 실제로 들어오는가?
- PLL/clock manager의 `clock_ready` 의미가 edge quality를 보장하는가?
- Frequency transition이나 mux switch 중 release하지 않는가?
- Clock가 멈출 수 있다면 release pending 상태를 어디서 보존하는가?

“PLL lock” 또는 “clock ready”의 exact semantics는 implementation마다 다르므로 generic guide에서 고정하지 않는다. Reset controller는 해당 clock architecture가 제공하는 stable/available indication을 사용한다.

## 8. Clock가 멈추면 Release도 멈춘다

`async_reset_n`이 high가 되어도 `clk` edge가 없으면 `release_q=00`에 머문다.

```text
async_reset_n rises
        ↓
clock stopped ──> no shift ──> local_reset_n remains 0
        ↓
clock resumes with clean edges
        ↓
release chain fills ──> local_reset_n rises
```

이는 안전한 지연이지 failure가 아니다. 하지만 system이 reset completion을 기다리면서 clock enable을 같은 stopped domain이 소유하면 self-deadlock이 된다. [Reset with Clock Gating](reset_with_clock_gating.md)에서 root control sequence를 정의한다.

## 9. Independent Reset Domains

한 domain만 reset될 때 retained peer state와 protocol을 정의한다.

| Protocol state | One-sided reset 위험 | 가능한 contract |
|---|---|---|
| Level status | stale observation | ready 후 current level로 수렴 |
| Toggle event | phase mismatch, phantom event | baseline/epoch handshake |
| Request/ack | deadlock 또는 duplicate | abort/reinitialize/timeout |
| Bundled data | old payload recapture | outstanding discard/retry |
| FIFO pointer | false full/empty | coordinated init or proven asymmetry |
| Multi-bit control | partial/reconvergent state | isolation + coherent rejoin |

Reset release synchronizer는 이러한 protocol state를 자동으로 복구하지 않는다. Source/destination reset policy는 [CDC Overview](../08_cdc/overview.md)와 protocol-specific 문서의 no-loss/no-duplicate requirement를 함께 따른다.

## 10. Reset Ordering and Self-deadlock

Domain B release가 A의 `ready`를 기다리고, A release가 B의 response를 기다리면 circular dependency가 생긴다.

```text
A reset release waits for B ready
            ↑              ↓
        B reset release waits for A ack
```

Reset controller는 다음을 명시한다.

- Ordering graph and root owner
- Clock availability prerequisites
- Which acknowledgement is generated while peer is reset
- Timeout/error/retry behavior
- Back-to-back reset restart/coalescing policy
- Power/isolation release order

Reset sequencing state는 그것이 release해야 할 function reset/clock 아래에 두지 않는다.

## 11. Reconvergence and RDC Review

Related resets 또는 reset-derived valid들이 다른 paths에서 reconverge하면 partial release가 기능에 보일 수 있다.

```text
local_reset_a_n ─> state A ─┐
                            ├─> decision / side effect
local_reset_b_n ─> state B ─┘
```

Mitigation candidates:

- Destination-side combined `all_domains_ready`
- Isolation until each domain reports reset done
- Re-initialization handshake
- Version/epoch tagging
- Related state를 한 reset owner/domain으로 재partition

RDC tool recognition은 출발점이다. Functional ordering, stale-state policy와 reconvergence invariant는 design review와 assertions가 담당한다.

## 12. SVA Sampling Guidance

다음 property는 ideal digital release sequence를 clock sample 기준으로 점검한다.

```systemverilog
ap_release_requires_two_high_samples:
    assert property (@(posedge clk)
        $rose(local_reset_n) |->
            $past(async_reset_n, 1) && $past(async_reset_n, 2)
    );
```

Concurrent SVA는 preponed region에서 sample한다. `local_reset_n`은 E2 NBA 뒤 high가 되므로 `$rose(local_reset_n)`은 E3 sample에서 관찰된다. 이때 `$past(async_reset_n,1/2)`는 E2와 E1 samples를 가리킨다. 초기 two samples가 존재하기 전에는 verification environment가 reset을 유지하거나 assertion enable을 별도 qualify해야 한다.

이 property는 다음을 증명하지 않는다.

- Analog metastability resolution or MTBF
- Recovery/removal sign-off
- Sub-cycle asynchronous assertion latency
- Clock quality or minimum pulse width
- Physical placement correctness

Asynchronous assertion은 `negedge async_reset_n` monitor, reset-aware simulation, structural/RDC checks와 cell timing analysis를 별도로 사용한다. Same timestamp의 reset/clock race를 testbench scheduling 우연에 맡기지 않는다.

## 13. Synthesis, STA와 Physical View

### Synthesis

- Exactly two intended stages remain
- Stage merge/retime/duplication 없음
- First-stage output has only second-stage functional fanout
- Async reset polarity/control maps as intended
- Chain is recognized by implementation flow

### STA and RDC

- Raw async reset path treatment follows reset methodology
- Recovery/removal and minimum pulse checks are not broadly hidden
- First-to-second stage path preserves resolution opportunity
- Local reset release to downstream async controls is analyzed
- Independent reset domains and reconvergence are reported/reviewed

### Physical

- Stages are placed close together
- First-stage load and route are minimal
- `local_reset_n` distribution meets fanout/skew needs
- Reset tree does not create excessive detour near synchronizer
- Post-route delay and reliability evidence meet the target

## 14. Timing, Power, Area Trade-off

| Choice | Timing/latency | Power | Area | Risk |
|---|---|---|---|---|
| Raw async deassertion | nominally no sync latency | least sync activity | no chain | recovery/removal/RDC |
| Two-stage local release | 2 clean edges + downstream next edge | small clock activity | 2 FF/domain | delayed readiness |
| More stages | longer release | more FF clock activity | more FFs | lower throughput at startup |
| One global chain | one chain | fewer FFs | smaller logical count | unsafe across unrelated clocks |
| Per-domain chains | domain-local safety | per-domain activity | more FF/tree | ordering/ready control |

Stage 수와 cell choice는 required reliability, reset rate, clock range와 project methodology로 결정한다. Fixed two-stage example이 모든 target의 충분조건은 아니다.

## 15. 적용하면 안 되는 경우

- Destination clock이 영구히 멈출 수 있는데 release completion을 무조건 요구하는 경우
- One global release chain을 unrelated clocks에 배포하는 경우
- First-stage output을 ready/enable/debug에 사용하는 경우
- Async reset source의 pulse width/glitch qualification이 없는 경우
- One-sided reset 뒤 event/handshake baseline이 정의되지 않은 경우
- Project RDC/DFT methodology가 다른 approved structure를 요구하는데 generic code를 강제하는 경우

## 16. Common Mistakes

- Async assertion과 async deassertion을 하나의 장점으로 묶는다.
- Reset synchronizer를 일반 data 2FF로 대체하거나 그 반대로 한다.
- “두 stage”를 exact two-cycle functional latency로 단정한다.
- E2 NBA release와 E2 downstream normal capture를 같은 것으로 본다.
- Clock stopped 상태에서 release가 완료된다고 가정한다.
- First-stage fanout과 physical placement를 검토하지 않는다.
- RDC tool recognized 결과만으로 reset ordering과 stale-state protocol이 증명됐다고 본다.

## 17. Verification Strategy

- Raw reset assertion at arbitrary clock phase
- Deassertion before, near and after destination edges
- Short pulse and repeated reset assertion
- Clock stop before release, restart and frequency changes
- Release chain nominal and delayed-fill behavior
- Downstream first normal edge after local release
- Independent domain reset and reset ordering
- Stale valid, phantom toggle, request/ack deadlock and reconvergence
- Structural chain recognition and first-stage fanout
- Post-route recovery/removal, resolution opportunity and reset tree review

RTL simulation cannot inject true analog metastability. Randomized phase tests are protocol tests, not MTBF proof.

## 18. Design Review Checklist

- [ ] Reset polarity와 raw/local reset 이름이 명확한가?
- [ ] Assertion은 async인지, release는 어느 clock에 동기화되는가?
- [ ] 각 destination clock domain에 local release structure가 있는가?
- [ ] Two clean edges와 downstream first active edge를 구분했는가?
- [ ] First-stage output이 second stage 외 logic에 사용되지 않는가?
- [ ] Clock stopped/missing 상태의 release pending semantics가 있는가?
- [ ] Pulse width, clock-ready와 power/isolation prerequisite가 정의됐는가?
- [ ] Independent reset domain의 outstanding transaction/rejoin 정책이 있는가?
- [ ] Reset ordering graph에 circular dependency가 없는가?
- [ ] SVA sampling, NBA와 async assertion test 역할을 구분했는가?
- [ ] Synthesis/STA/RDC/physical flow가 chain을 인식하고 분석하는가?

## 관련 문서

- [Reset Architecture Overview](overview.md)
- [Synchronous vs Asynchronous Reset](sync_vs_async_reset.md)
- [Reset with Clock Gating](reset_with_clock_gating.md)
- [Metastability](../08_cdc/metastability.md)
- [2FF Synchronizer](../08_cdc/synchronizer.md)
- [CDC Overview](../08_cdc/overview.md)
