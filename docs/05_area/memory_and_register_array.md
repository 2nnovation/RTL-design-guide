# Memory and Register Array

논리적으로 같은 `DEPTH × DATA_W` storage라도 FF array, inferred memory와 hard macro는 area, timing, power와 검증 특성이 크게 다르다. RTL shape만으로 mapping을 보장할 수 없으며 read/write port, latency, reset, mask, collision semantics와 target memory compiler가 구현을 결정한다.

> “배열 문법을 썼으니 SRAM으로 간다”거나 “FF 수 × cell area가 memory area다”라고 가정하지 않는다. Inference report, selected macro, wrappers, floorplan과 timing evidence를 확인한다.

전체 area 의사결정 순서는 [Area Overview](overview.md), reset이 inference에 주는 영향은 [Reset Area Cost](reset_area_cost.md), buffering/queue architecture는 [Buffering and Backpressure](../02_architecture/buffering_and_backpressure.md)가 담당한다.

## 1. Storage Architecture를 먼저 정한다

```text
capacity and behavior
  ├─ depth × width
  ├─ read/write ports
  ├─ sync/async read and latency
  ├─ byte/bit write enable
  ├─ same-address collision semantics
  ├─ reset/init/ECC/test requirements
  └─ throughput, banking and arbitration
                ↓
       FF array / inferred RAM / macro
```

같은 bit capacity라도 2R1W, asynchronous read, per-bit reset을 요구하면 single-port SRAM과 전혀 다른 구조가 필요하다. 먼저 behavior contract를 고정하고 target에서 지원하는 memory shape와 맞춘다.

## 2. FF Array, Inferred Memory와 Macro

| 구현 | 장점 | 비용/제약 | 적합한 경우 |
|---|---|---|---|
| FF array | 임의 reset/port, 작은 구조에 단순 | clock/reset load, decoder/MUX/routing | 매우 작거나 특수한 port/latency |
| Inferred memory | RTL portability, tool mapping | coding template와 tool support 의존 | 지원되는 표준 read/write shape |
| Explicit macro wrapper | PPA/physical 특성 명확 | target 종속, model/DFT integration | stable macro/compiler flow |
| Banked memories | parallel access/throughput | bank select, conflict, imbalance | 주소가 분산되거나 arbitration 가능 |
| Replicated memories | read ports/locality 증가 | capacity/write fanout 증가 | read-heavy, coherent writes 가능 |

작은 memory는 wrapper와 peripheral overhead 때문에 FF array가 더 나을 수 있다. 큰 memory는 bitcell density가 지배적이지만 macro 주변의 decoder, sense amp, spare, ECC와 power structures도 포함한다.

## 3. Port 수는 Area Architecture다

Read/write port를 하나 추가하는 것은 단순 RTL wire 추가가 아니다.

- True multi-port cell/macro 사용
- Memory replication 후 write broadcast
- Banking과 bank-conflict handling
- Time multiplexing과 arbitration
- Faster internal clock를 이용한 multi-pumping

각 대안은 capacity, control, latency, throughput, clocking과 verification contract가 다르다. “동시에 실제로 필요한 access인가?”를 먼저 확인하고 [Resource Sharing vs Duplication](../02_architecture/resource_sharing_vs_duplication.md)의 arbitration 판단을 적용한다.

```text
two logical reads
  ├─ true 2R memory
  ├─ duplicate 1R memories + broadcast writes
  └─ one 1R memory + arbitration + latency
```

Replication은 logical bit count를 늘리지만 read locality와 timing을 개선할 수 있다. 반대로 central multi-port structure가 placed area와 congestion을 더 키울 수 있다.

## 4. Read Latency와 Output Register

Asynchronous read는 address → decoder/memory → data MUX가 같은 cycle의 combinational path가 된다. Synchronous read는 request edge 뒤 output register에서 data가 나타나는 contract다.

- Async read가 target RAM template에 맞지 않으면 FF+MUX로 구현될 수 있다.
- Registered output은 latency를 추가하지만 timing과 macro mapping을 개선할 수 있다.
- Output register가 macro 내부인지 외부 FF인지에 따라 area/clock/reset가 달라진다.
- Bypass가 있으면 same-address collision path가 critical해질 수 있다.

Latency 변경은 microarchitecture optimization이지 문법 수정이 아니다. Consumer schedule, backpressure와 formal latency relation을 함께 갱신한다.

## 5. Generic 1R1W Synchronous-read Example

다음은 특정 vendor template가 아닌 generic contract 예제다.

- `DATA_W >= 1`, `DEPTH >= 1`만 지원하며 integration/elaboration flow가 그 밖의 값을 거부해야 한다.
- `wr_valid`/`rd_valid`는 request다.
- `*_accept = *_valid && *_ready`만 실제 access로 센다.
- Reset 동안 두 ready는 false이고 access는 없다.
- Address는 valid일 때 항상 `0..DEPTH-1`인 interface requirement다. Illegal address는 backpressure 대상이 아니라 protocol violation이다.
- Read output은 accepted read edge 직후 registered output으로 유효해진다.
- 같은 edge에 같은 address read/write가 accept되면 write-first bypass로 새 data를 반환한다.
- Array contents는 reset하지 않고 `rd_out_valid`만 reset한다.

```systemverilog
module generic_1r1w_memory #(
    parameter int unsigned DATA_W = 32,
    parameter int unsigned DEPTH  = 16,
    localparam int unsigned ADDR_W =
        (DEPTH <= 1) ? 1 : $clog2(DEPTH)
) (
    input  logic                  clk,
    input  logic                  rst_n,

    input  logic                  wr_valid,
    input  logic [ADDR_W-1:0]     wr_addr,
    input  logic [DATA_W-1:0]     wr_data,
    output logic                  wr_ready,

    input  logic                  rd_valid,
    input  logic [ADDR_W-1:0]     rd_addr,
    output logic                  rd_ready,
    output logic                  rd_out_valid,
    output logic [DATA_W-1:0]     rd_data
);
    localparam logic [ADDR_W-1:0] LAST_ADDR =
        ADDR_W'(DEPTH - 1);

    logic [DATA_W-1:0] mem [0:DEPTH-1];
    logic              wr_in_range;
    logic              rd_in_range;
    logic              wr_accept;
    logic              rd_accept;

    assign wr_in_range = (wr_addr <= LAST_ADDR);
    assign rd_in_range = (rd_addr <= LAST_ADDR);

    assign wr_ready  = rst_n;
    assign rd_ready  = rst_n;
    assign wr_accept = wr_valid && wr_ready;
    assign rd_accept = rd_valid && rd_ready;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            rd_out_valid <= 1'b0;
        end else begin
            rd_out_valid <= rd_accept;

            if (wr_accept) begin
                mem[wr_addr] <= wr_data;
            end

            if (rd_accept) begin
                if (wr_accept && (wr_addr == rd_addr)) begin
                    rd_data <= wr_data;
                end else begin
                    rd_data <= mem[rd_addr];
                end
            end
        end
    end
endmodule
```

`DEPTH`가 power of two가 아니면 unused address code가 생긴다. 예제는 `LAST_ADDR`를 address와 같은 명시적 width로 만들고 legal-address assertion에 사용한다. Ready를 address에 의존시키지 않으므로 illegal request가 영구 stall되는 모호함이 없다. 대신 invalid address가 들어오면 contract violation이며 memory indexing 결과는 정의하지 않는다. Invalid request를 정상적으로 처리해야 한다면 별도 error/reject response와 그 acceptance semantics를 interface에 추가해야 한다.

`DEPTH=1`에서는 `ADDR_W=1`, `LAST_ADDR=0`이므로 address zero만 legal하다. `DATA_W=0` 또는 `DEPTH=0`은 이 module의 지원 범위 밖이며 lint/elaboration configuration check가 실패시켜야 한다. Parameter guard를 어떤 문법으로 넣는지는 synthesis flow가 지원하는 elaboration assertion 방식에 맞춘다.

Array 전체를 reset하지 않았으므로 reset 뒤 write되지 않은 entry를 읽으면 stale/unknown data가 나올 수 있다. Protocol은 valid bitmap, initialization sequence 또는 unread-before-write 금지 중 하나로 이를 막아야 한다.

### Cycle audit

```text
edge                         E0          E1             E2          E3
rst_n                        0           1              1           1
write req                    -           A/old          A/new       -
read req                     -           -              A           A
wr_ready/rd_ready            0/0         1/1            1/1         1/1
accepted access              none        write          write+read  read
read output after edge       invalid     invalid        valid/new   valid/new
collision rule               -           -              write-first none
```

E2의 `new`은 bypass로 전달된다. E3은 E2에 저장된 동일한 `new`을 memory에서 읽는다. Reset 중 E0에는 request가 있어도 ready/accept가 false다.

## 6. Read-during-write Semantics

Target memory는 same-address collision에서 다음 중 하나일 수 있다.

- Write-first/new data
- Read-first/old data
- No-change
- Undefined 또는 restricted

RTL이 특정 behavior를 암묵적으로 요구하면 target macro가 맞지 않을 때 bypass/MUX 또는 wrapper state가 추가된다. Contract가 collision을 금지할 수 있다면 assertion으로 금지하고 extra bypass를 제거할 수 있다. 허용해야 한다면 simulation model, RTL, macro model과 gate implementation을 일치시킨다.

## 7. Write Enable Granularity

Byte/bit mask는 partial update 기능이지만 memory shape를 제한한다.

```text
new_word = (old_word & ~mask) | (write_data & mask)
```

Native byte-enable macro가 없으면 read-modify-write가 필요할 수 있다. 이는 extra read port/cycle, temporary state와 collision handling을 만든다. 여러 field가 정말 독립 update되어야 하는지, word를 bank로 분할할지, writer가 full word를 만들 수 있는지 검토한다.

Mask width를 줄이는 것이 반드시 area를 줄이지 않는다. 지원되는 compiler granularity와 alignment가 더 중요할 수 있다.

## 8. Reset, Initialization과 Validity

Whole-array reset은 FF array를 강제하거나 macro 주변에 initialization logic을 추가할 수 있다. 대안은 다음과 같다.

- Valid bit/bitmap만 reset
- Epoch/generation tag로 logical invalidation
- Boot-time initialization sweep
- First-use write requirement
- Macro가 제공하는 initialization 기능 사용

각 대안은 stale-data observation, startup latency, bitmap/tag area, wrap와 recovery contract가 있다. 자세한 판단은 [Reset Area Cost](reset_area_cost.md)를 따른다.

## 9. ECC, Parity, Redundancy와 Repair

Raw payload bits만 계산하면 storage area를 과소평가한다.

- ECC/parity check bits
- Encoder/decoder and syndrome logic
- Scrub/read-modify-write state
- Spare rows/columns and repair metadata
- BIST/DFT wrapper
- Redundant copies and comparison

ECC는 data width와 macro organization에 따라 overhead가 달라진다. Correction latency, error reporting, partial write와 initialization도 architecture에 포함한다.

## 10. Banking과 Address Mapping

Banking은 port pressure와 locality를 줄일 수 있지만 conflict가 생긴다.

```text
address ──> bank select ──┬─ bank 0
                          ├─ bank 1
                          └─ bank N
                 conflict/arbitration
```

Low address bit interleave, range partition 또는 hash mapping은 workload conflict 분포가 다르다. Worst-case throughput과 queue depth를 trace/workload로 확인한다. Bank마다 작은 macro를 쓰면 peripheral overhead가 늘 수 있고, floorplan channel이 커질 수도 있다.

## 11. Physical View

Memory macro는 rectangular blockage와 pin topology를 가진다. Logical area 외에 다음이 중요하다.

- Macro halo/keepout와 routing channels
- Address/control pin side와 consumer locality
- Wide data bus의 entry/exit congestion
- Clock/reset/test route
- Multiple banks 사이의 crossbar
- Voltage area와 power-grid constraints

Macro core area가 작아도 bus crossing과 placement whitespace 때문에 block footprint가 커질 수 있다. [Physical Area and Congestion](physical_area_and_congestion.md)에서 placed utilization과 congestion을 확인한다.

## 12. Synthesis, STA와 Evidence

### Synthesis/inference

- Inferred memory type, depth/width와 number of instances
- FF/latch fallback 여부
- Output register와 bypass location
- Write mask and port mapping
- Reset 때문에 inference가 깨졌는지

### STA

- Address/control → memory input
- Memory clock-to-data → consumer
- Same-address bypass compare/MUX
- Bank select/arbitration path
- High-fanout write enable/address broadcast

### Evidence table

| Candidate | Mapping | Logical capacity | Extra logic | Critical path | Placed concern |
|---|---|---:|---|---|---|
| FF array | FF+MUX | `D×W` | decode/reset | read MUX | clock/routing |
| 1R1W macro | memory | `D×W` | bypass/valid | macro access | pins/channel |
| Replicated 1R | 2 memories | `2×D×W` | write fanout | read local | capacity/write route |
| Banked | N memories | `D×W` | select/conflict | arbitration | bank channels |

## 13. PPA Trade-off

| Choice | Timing | Power | Area | Contract/physical risk |
|---|---|---|---|---|
| FF array | Small depth에는 짧을 수 있으나 read MUX 증가 | FF clock/reset activity | depth와 port에 따라 빠르게 증가 | route/clock load |
| Synchronous memory | Fixed access latency | dense bitcell, macro activity | bit density 개선 가능 | latency/collision mapping |
| Extra read-port replication | Local read path 가능 | write broadcast와 duplicate storage | capacity 증가 | coherency/write fanout |
| Banking | Parallel access 가능 | active bank 선택 가능 | select/conflict logic | conflict/floorplan channels |
| Whole-array reset 제거 | inference/timing freedom 가능 | reset switching 감소 | reset network 감소 가능 | unread-before-write |

수치는 target compiler/library, access activity와 floorplan에 따라 달라진다. 같은 capacity만이 아니라 동일한 port, latency, mask, collision와 validity contract로 비교한다.

## 14. 적용하면 안 되는 경우

- Required latency나 collision behavior를 target memory가 지원하지 않는데 inference를 강제하는 경우
- Invalid/uninitialized entry를 관찰할 수 있는데 valid/initialization 없이 array reset을 제거하는 경우
- 동시 access requirement를 arbitration latency 없이 single-port memory로 축소하는 경우
- Independent write port를 replication하면서 write ordering/coherency를 증명하지 못하는 경우
- Tiny storage에서 wrapper, bypass와 macro boundary cost를 제외하고 macro가 항상 작다고 가정하는 경우
- Safety, ECC, DFT 또는 repair requirement를 raw capacity 최적화로 삭제하는 경우

## 15. Common Mistakes

- Array syntax만 보고 SRAM inference를 가정한다.
- Required port가 아니라 편한 interface를 그대로 multi-port로 만든다.
- Read latency 변경을 기능 변경 없이 적용할 수 있다고 본다.
- Same-address collision behavior를 simulation 우연에 맡긴다.
- Whole-array reset과 per-bit mask가 mapping에 주는 영향을 무시한다.
- Raw bit capacity만 세고 ECC, wrapper, bypass, arbitration을 제외한다.
- Macro area만 비교하고 halo, pin access와 bus congestion을 제외한다.
- Non-power-of-two address와 `DEPTH=1` parameter edge를 검증하지 않는다.

## 16. Verification Strategy

- Reference model로 read/write ordering 확인
- Same-address collision의 write-first/read-first/forbidden contract
- Back-to-back read/write와 independent 1R1W operation
- Reset 중 ready/accept false, reset 뒤 unread-before-write
- Legal address assertion, deliberate illegal-address violation test와 non-power-of-two depth
- Byte mask, ECC error injection과 partial write
- Bank conflict, starvation and ordering
- RTL model와 selected macro model equivalence
- Synthesis inference report와 post-layout timing/congestion

```systemverilog
ap_no_out_of_range_write:
    assert property (@(posedge clk) disable iff (!rst_n)
        wr_valid |-> wr_in_range
    );

ap_no_out_of_range_read:
    assert property (@(posedge clk) disable iff (!rst_n)
        rd_valid |-> rd_in_range
    );

ap_collision_returns_new_data:
    assert property (@(posedge clk) disable iff (!rst_n)
        wr_accept && rd_accept && (wr_addr == rd_addr)
        |=> rd_out_valid && (rd_data == $past(wr_data))
    );
```

## 17. Design Review Checklist

- [ ] Capacity뿐 아니라 ports, latency, mask와 collision semantics가 정의됐는가?
- [ ] FF, inferred memory와 macro 후보를 같은 기능으로 비교했는가?
- [ ] Reset/init/unread-before-write contract가 명시됐는가?
- [ ] Request와 accepted access를 분리하고 reset 시 acceptance를 막았는가?
- [ ] Depth/width/address parameter edge를 확인했는가?
- [ ] ECC, repair, BIST, bypass와 arbitration overhead를 포함했는가?
- [ ] Inference report와 selected macro를 확인했는가?
- [ ] Macro halo, pins, wide bus와 congestion까지 footprint에 포함했는가?

## 관련 문서

- [Area Overview](overview.md)
- [Reset Area Cost](reset_area_cost.md)
- [Bit Width Minimization](bit_width_minimization.md)
- [Resource Sharing vs Duplication](../02_architecture/resource_sharing_vs_duplication.md)
- [Buffering and Backpressure](../02_architecture/buffering_and_backpressure.md)
- [Physical Area and Congestion](physical_area_and_congestion.md)
