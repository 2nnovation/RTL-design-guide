# Independent 2FF Bus

2FF synchronizer는 persistent single-bit level의 metastability가 functional logic으로 전파될 확률을 낮추는 구조다. Multi-bit bus의 각 bit에 2FF를 하나씩 붙이면 각 chain의 metastability containment에는 도움이 될 수 있지만, destination이 같은 source word를 atomic하게 받는다는 보장은 생기지 않는다.

[2FF Synchronizer](../08_cdc/synchronizer.md)는 single-bit 적용 조건, [Multi-Bit CDC](../08_cdc/multi_bit_cdc.md)는 구조 선택, [Bundled-Data CDC](../08_cdc/bundled_data.md)와 [Pulse Crossing](../08_cdc/pulse_crossing.md)은 transaction/event protocol을 정본으로 다룬다. 이 문서는 review에서 **independent 2FF bus를 찾아 coherency contract와 대체 구조의 증거를 요구하는 방법**에 집중한다.

## 1. 문제: bit별 동기화를 word 동기화로 해석한다

```systemverilog
logic [BUS_W-1:0] sync_meta_q;
logic [BUS_W-1:0] sync_bus_q;

always_ff @(posedge dst_clk) begin
    sync_meta_q <= async_bus;
    sync_bus_q  <= sync_meta_q;
end
```

코드 모양은 2FF가 BUS_W개 병렬로 있는 구조다. `sync_bus_q`의 각 bit가 destination-domain FF에서 나오더라도 다음은 보장되지 않는다.

- 모든 bit가 같은 source transaction에 속한다.
- 여러 source bit transition이 같은 destination cycle에 반영된다.
- Control과 data가 같은 epoch 또는 mode에 속한다.
- Source update 하나가 정확히 한 번 전달된다.

Bus width가 2비트이거나 update rate가 낮다는 사실만으로 coherency가 생기지 않는다.

## 2. 실제 cycle scenario: old/new bit가 섞인다

Source binary word가 `0111`에서 `1000`으로 바뀐다고 하자. 네 bit가 source FF에서 같은 edge에 바뀌어도 clock-to-Q, route와 destination setup/hold aperture 관계가 bit마다 다르다.

```text
source word       0111 ----------------------> 1000
                  b3 rises, b2:b0 fall

dst edge D0                 ↑
first-stage samples       old/new decision differs by bit

dst edge D1                          ↑
second-stage word may be     0000, 1111, 1010, ...

dst edge D2                                    ↑
eventually converges to                    1000
```

어떤 bit는 D0에서 new value를 capture하고, 다른 bit는 old value로 남거나 metastability resolution 때문에 한 cycle 늦을 수 있다. D1의 second-stage 출력은 실제 source가 한 번도 만든 적 없는 조합이 될 수 있다.

RTL zero-delay simulation은 source와 destination edge phase에 따라 old/new 혼합을 일부 보여 줄 수 있지만, analog metastability resolution과 silicon 확률을 직접 모델링하지 않는다. Simulation에서 수백만 cycle 동안 coherent했다는 결과는 independent 2FF bus의 안전성 증명이 아니다.

## 3. Reconvergence와 control/data mismatch

### Related controls

두 control을 각각 synchronize한 뒤 reconverge하면 source에 없던 intermediate state가 생길 수 있다.

```text
mode[0] ── 2FF ──┐
                  ├── destination decode --> command
mode[1] ── 2FF ──┘
```

One-hot transition `0010 → 0100`도 old bit deassert와 new bit assert라는 두 물리 transition이다. Destination은 잠시 zero-hot 또는 two-hot을 볼 수 있다.

### Separately synchronized valid and data

Data bus를 bit별 2FF에 넣고 `valid`를 별도 2FF에 넣으면 두 경로의 effective latency가 다를 수 있다. `valid_sync=1`인 cycle에 `data_sync` 일부가 이전 transaction이면 atomic delivery가 깨진다. Synchronizer stage 수를 같게 맞추는 것만으로 analog resolution과 route 차이를 없앨 수 없다.

### Reset epoch mismatch

Source만 reset되거나 destination synchronizer만 reset되면 old word와 new valid, old toggle phase와 new request가 결합할 수 있다. Reset 뒤 첫 word를 버리는지, outstanding transaction을 abort하는지, initialization handshake 또는 epoch/version을 쓰는지 정의해야 한다.

## 4. 구조 선택표

| 구조 | 적합한 정보 | 핵심 조건 | 해결하지 못하는 것 |
|---|---|---|---|
| Single-bit 2FF level | 오래 유지되는 독립 status/control 한 bit | Minimum level duration, latency uncertainty, MTBF | Pulse count, related-bit coherency |
| Gray-encoded state | 인접 상태로 이동하는 monotonic pointer/count | Source registered, consecutive transition, skipped state 허용, physical skew 검증 | Arbitrary payload snapshot |
| Bundled data | 드문 multi-bit snapshot/configuration | Payload hold, synchronized capture control, no overwrite | Hold할 수 없는 continuous stream |
| Toggle | Rate가 제한된 single event | 두 toggle 사이 destination 관찰, reset phase | 여러 빠른 event와 payload coherency |
| Request/ack handshake | Exactly-once event 또는 held payload | Source hold, round-trip protocol, reset convergence | 높은 II가 필요한 무버퍼 stream |
| Async FIFO | Continuous/burst ordered payload | Full/empty, Gray pointer, depth, reset/overflow policy | 무한 burst 또는 검증 없는 custom FIFO |

구조 이름만 고르면 끝나지 않는다. Traffic rate, loss/duplicate 허용 여부, destination clock stop, reset independence와 throughput requirement가 선택을 결정한다.

## 5. Better architecture: bundled-data handshake 예

다음 개념 예는 two-phase request/acknowledge를 사용한다. Payload는 source register에서 hold되고, request toggle만 single-bit synchronizer를 통과한다. Destination은 새 request를 한 번 capture한 뒤 acknowledge phase를 맞춘다.

```systemverilog
// Source domain
assign src_busy = (req_toggle_q != ack_sync);

always_ff @(posedge src_clk or negedge src_rst_n) begin
    if (!src_rst_n) begin
        req_toggle_q <= 1'b0;
    end else if (src_accept && !src_busy) begin
        payload_hold <= src_payload;
        req_toggle_q <= ~req_toggle_q;
    end
end

// Destination domain
always_ff @(posedge dst_clk or negedge dst_rst_n) begin
    if (!dst_rst_n) begin
        ack_toggle_q <= 1'b0;
        dst_valid    <= 1'b0;
    end else begin
        dst_valid <= 1'b0;

        if (req_sync != ack_toggle_q) begin
            dst_payload  <= payload_hold;
            dst_valid    <= 1'b1;
            ack_toggle_q <= req_sync;
        end
    end
end
```

`req_sync`는 `req_toggle_q`의 destination-domain synchronized level이고, `ack_sync`는 `ack_toggle_q`의 source-domain synchronized level이다. Synchronizer first stage는 functional logic에 사용하지 않는다.

이 예의 priority는 source에서 `reset > accepted transfer > hold`, destination에서 `reset > new request capture > idle`이다. Source는 `src_busy=1`인 동안 `payload_hold`를 바꾸지 않아야 한다. Reset 후 두 toggle phase가 일치한 상태에서만 traffic을 시작한다는 계약을 사용하므로 independent reset을 지원하려면 initialization handshake, abort/epoch 정책 또는 검증된 reusable CDC component가 추가로 필요하다.

이 코드는 모든 multi-bit CDC의 보편적인 답이 아니다. Required II가 round-trip보다 짧거나 여러 outstanding transaction이 필요하면 async FIFO나 multi-entry protocol을 선택한다.

## 6. Gray code의 정확한 경계

Gray code는 consecutive count 사이 한 bit만 바뀌게 하여 binary pointer의 simultaneous multi-bit transition 문제를 줄인다. 그러나 다음 조건이 함께 필요하다.

- Gray value가 source clock에서 register되어 combinational glitch를 crossing에 내보내지 않는다.
- Source state가 Gray sequence의 인접 code로만 이동한다.
- Destination이 intermediate source state를 건너뛰어 관찰해도 protocol이 안전하다.
- Destination은 synchronized pointer를 arbitrary payload로 해석하지 않고 full/empty 같은 허용된 관계에 사용한다.
- Source register에서 destination synchronizer까지 bit별 route skew/max delay가 “한 번에 한 bit 변화”라는 관찰 가정을 깨지 않는지 target methodology로 확인한다.

Logical Gray property만 검증하고 physical constraint를 모두 false path로 제거하면 route delay 차이가 여러 source transition을 destination observation window에 겹치게 할 수 있다. 사용할 max-delay, bus-skew 또는 placement check의 정확한 명령과 기준은 FPGA/ASIC flow와 clock relationship에 따라 공식 문서에서 확인한다.

Arbitrary sensor word, configuration vector나 data payload를 Gray encode하는 것은 일반적인 atomic snapshot 해결책이 아니다.

## 7. 제한적인 예외: truly independent bit와 quasi-static bus

### Functionally independent status bits

각 bit가 서로 무관하고 destination에서 조합하지 않으며 bit별 latency 차이를 허용한다면 개별 2FF가 적합할 수 있다. 예를 들어 서로 다른 long-lived alarm level을 각각 독립적으로 처리하는 경우다. 나중에 두 bit를 같은 decision에서 reconverge하면 예외 조건을 다시 검토한다.

### Quasi-static configuration

Configuration bus가 매우 드물게 바뀌고 destination capture 전후 충분히 오래 유지되는 경우도 있다. 안전성은 independent 2FF가 우연히 같은 cycle에 수렴해서가 아니라 다음 protocol에서 나온다.

1. Source가 configuration을 register하고 고정한다.
2. Settle interval 뒤 capture request를 안전하게 전달한다.
3. Destination이 request에 따라 한 번 snapshot한다.
4. Capture/acknowledge 전에는 source가 bus를 바꾸지 않는다.

즉, 본질은 open/closed-loop bundled-data protocol이다. “software가 천천히 쓴다”는 설명만으로는 clock stop, back-to-back write와 reset overlap을 증명할 수 없다.

## 8. CDC·physical·PPA evidence

### Structural CDC

- Multi-bit unsynchronized path와 per-bit synchronizer bank를 찾는다.
- Related signal reconvergence, encoded control와 separately synchronized valid/data를 확인한다.
- First-stage fanout, stage 사이 logic과 synchronizer identification metadata를 확인한다.
- Waiver에는 source stability, control protocol, capture point, reset policy와 physical check를 연결한다.

### Physical/reliability

- Synchronizer stage가 target flow에서 recognized되고 적절히 배치됐는지 확인한다.
- Characterized cell, stage-to-stage resolution time, source transition rate와 destination clock 범위로 MTBF 목표를 검토한다.
- Gray/bundled-data의 relative-delay 또는 skew 조건을 signoff methodology로 확인한다.
- Async FIFO memory, pointer synchronizer와 full/empty logic의 physical/timing coverage를 확인한다.

### PPA

Per-bit 2FF는 최소 `2 × BUS_W` sequential bit와 wide CDC routing을 추가하면서 coherency는 해결하지 못한다. Handshake는 payload hold/capture FF와 control latency를, FIFO는 memory와 pointer logic을 추가한다. Area만이 아니라 throughput, event loss risk, clock power와 route congestion을 함께 비교한다.

## 9. Verification strategy

### 독립 schedule model

각 bit의 second-stage arrival cycle을 `{D1, D2}` 중 하나로 독립 배정해 old/new word 조합을 열거한다. 두 bit 이상이 바뀌면 mixed word가 가능한지 확인하고, destination decoder가 그 조합에서 side effect를 내지 않는지 본다. 이 digital model은 metastability 확률을 계산하지 않지만 protocol의 coherency 취약성을 드러낸다.

### Assertions와 scoreboard

```systemverilog
ap_payload_stable_while_busy:
    assert property (@(posedge src_clk) disable iff (!src_rst_n)
        src_busy && $past(src_busy) |-> $stable(payload_hold));

ap_capture_only_new_request:
    assert property (@(posedge dst_clk) disable iff (!dst_rst_n)
        dst_valid |-> (req_sync != $past(ack_toggle_q)));
```

Project SVA sampling과 reset history에 맞게 `past_valid` guard가 필요할 수 있다. End-to-end scoreboard는 accepted source transaction의 payload/tag/epoch와 destination capture를 연결해 no-loss, no-duplicate, ordering과 coherency를 확인한다.

필수 scenario:

- Multi-bit simultaneous transition과 source/destination phase sweep
- Fast-to-slow, slow-to-fast, variable frequency와 destination clock stop
- Minimum transaction spacing과 back-to-back accept 시도
- Source-only/destination-only reset과 outstanding transfer
- Gray pointer wrap 및 skipped observation
- FIFO full/empty, overflow/underflow와 asymmetric reset
- CDC waiver 대상 수와 synchronizer/reconvergence report regression

RTL simulation은 analog metastability를 증명하지 못한다. CDC structural analysis, protocol proof/assertions, MTBF와 implementation checks를 서로 대체하지 않고 함께 사용한다.

## 10. Design Review Checklist

- [ ] Destination이 요구하는 coherency/atomicity 단위가 정의됐는가?
- [ ] Bus bit가 실제로 독립인지 destination에서 reconverge하는지 확인했는가?
- [ ] Bit별 capture/resolution cycle 차이로 생기는 mixed word를 분석했는가?
- [ ] Valid/control과 data가 별도 synchronizer에서 mismatch하지 않는가?
- [ ] Single-bit level, Gray, bundled data, handshake와 FIFO 중 traffic에 맞는 구조인가?
- [ ] Gray source가 registered이고 consecutive code만 이동하는가?
- [ ] Gray bit skew/max-delay와 bundled payload ordering을 target flow에서 검증하는가?
- [ ] Quasi-static 예외가 stability+capture protocol로 정의됐는가?
- [ ] Independent reset에서 abort, retry, initialization 또는 epoch가 정의됐는가?
- [ ] First-stage fanout과 stage 사이 logic이 없는가?
- [ ] End-to-end no-loss/no-duplicate/order/coherency가 scoreboard/property로 검증되는가?
- [ ] CDC waiver가 구조·protocol·physical evidence와 owner를 포함하는가?

## 관련 문서

- [Multi-Bit CDC](../08_cdc/multi_bit_cdc.md): coherency 요구와 구조 선택의 정본
- [2FF Synchronizer](../08_cdc/synchronizer.md): single-bit level과 MTBF/placement 조건
- [Bundled-Data CDC](../08_cdc/bundled_data.md): payload stability와 request/acknowledge
- [Pulse Crossing](../08_cdc/pulse_crossing.md): pulse stretch, toggle, handshake와 rate 조건
- [Reset Deassertion and RDC](../07_reset/reset_deassertion.md): reset crossing과 controlled release
- [Lint, Formal, and Equivalence](../13_verification/lint_formal_equivalence.md): CDC tool, assumption과 proof 범위

## 참고 자료

- [AMD, Clock Domain Crossing](https://docs.amd.com/r/en-US/ug949-vivado-design-methodology/Clock-Domain-Crossing): synchronizer와 CDC 구조에 관한 FPGA 공식 방법론
- [AMD, Report Clock Domain Crossings](https://docs.amd.com/r/en-US/ug906-vivado-design-analysis/Report-Clock-Domain-Crossings): CDC 구조 분류와 report 검토에 관한 공식 문서
- [Clifford E. Cummings, Simulation and Synthesis Techniques for Asynchronous FIFO Design](http://www.sunburst-design.com/papers/CummingsSNUG2002SJ_FIFO1.pdf): Gray pointer와 asynchronous FIFO 설계의 공개 원 논문
